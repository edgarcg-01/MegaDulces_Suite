import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase WMS-REC (Pieza 3 — Ubicación bin-level lote×posición, ADR-044).
 *
 * Administra los bins (posiciones físicas) y el AUXILIAR DE UBICACIONES
 * (commercial.stock_lot_locations): cuánta cantidad de cada (producto, lote,
 * caducidad) está en cada bin. Regla: SUM(ubicado por lote) ≤ stock_lots.quantity;
 * el remanente = "por ubicar". FEFO físico: dirige el surtido al bin que caduca antes.
 *
 * No mueve stock (el saldo/FEFO lógico lo lleva stock_lots). Esto es la capa física.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Largos REALES de las columnas (`warehouse_bins.code` varchar(40),
 * `label` varchar(120), migración 20260817140000).
 *
 * Están acá porque sin ellos Postgres contesta `22001 value too long` y Nest lo
 * convierte en **500 "Internal server error"**: la pantalla dice "No se pudo
 * crear" sin decir por qué, y el operario vuelve a intentar lo mismo. Medido:
 * un código de 41 caracteres o un nombre de 121 tiraban 500 pelado. En el Andén
 * el código se arma con el campo libre *"Número o nombre"*, así que escribir el
 * nombre largo del rack alcanzaba para caer ahí.
 */
const CODE_MAX = 40;
const LABEL_MAX = 120;

/**
 * Caracteres que un código de ubicación puede llevar.
 *
 * **El código ES la llave del escaneo**, no una descripción: se imprime como
 * CODE128 en el cartel del rack y se busca con igualdad exacta. Por eso se
 * restringe a lo que sobrevive el viaje papel → pistola → base:
 * letras sin acento, dígitos y `- _ .`.
 *
 * Fuera quedan los espacios (un espacio al final es invisible en pantalla y hace
 * que el escaneo no encuentre nada), los acentos y la eñe (dependen de cómo esté
 * configurado el teclado que emula la pistola) y los símbolos que algunos
 * lectores traducen distinto.
 */
const CODE_OK = /^[A-Z0-9][A-Z0-9._-]*$/;

/**
 * Deja el código como se va a imprimir y como se va a escanear: **una sola
 * forma**.
 *
 * Mayúsculas y sin espacios. La pantalla ya lo hacía y el servidor no, así que
 * un alta por API con `r-12` creaba una ubicación que el cartel mostraba `r-12`
 * y que ningún escaneo de `R-12` encontraba — la búsqueda de `putAway` es
 * igualdad exacta. Normalizar en el borde del servidor es lo único que garantiza
 * que las dos puntas hablen del mismo código.
 */
export function normalizeBinCode(raw: unknown): string {
  const code = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-'); // "RACK 12" → "RACK-12": se conserva la intención, no el espacio
  if (!code) throw new BadRequestException('Escribí el código de la ubicación (es el que se imprime y se escanea).');
  if (code.length > CODE_MAX)
    throw new BadRequestException(
      `El código no puede pasar de ${CODE_MAX} caracteres (escribiste ${code.length}). Es la etiqueta que se pega en el rack: cortito se lee de lejos, p. ej. "R-12".`,
    );
  if (!CODE_OK.test(code))
    throw new BadRequestException(
      `El código "${code}" tiene caracteres que la pistola no lee igual siempre. Usá letras sin acento, números y - _ . — por ejemplo "R-12" o "T-03-A".`,
    );
  return code;
}

export interface CreateBinDto {
  warehouse_id: string;
  aisle_id?: string;
  code: string;
  label?: string;
}

/** Un renglón del contenido de un bin, tal como lo devuelve `binContents`. */
export interface BinContentRow {
  id: string;
  product_id: string | null;
  sku: string | null;
  product_name: string | null;
  lot_code: string;
  expiry_date: string | null;
  quantity: string | number;
  /** Días a la caducidad, calculados en la base. `null` = lote sin fecha. */
  days_to_expiry: number | null;
}

export interface PutAwayDto {
  warehouse_id: string;
  product_id: string;
  lot_code?: string;
  expiry_date?: string; // YYYY-MM-DD
  bin_id?: string;
  bin_code?: string; // alternativa a bin_id (escaneo de la etiqueta del bin)
  quantity: number;
}

/**
 * Mover mercancía YA acomodada de un rack a otro.
 *
 * El origen y el destino se pueden dar por id o por el código del cartel: quien
 * mueve tiene la pistola, no los UUID.
 */
/**
 * Si el almacén acepta movimientos ahora mismo, y si no, por qué.
 *
 * `frozen: false` con `folio: null` es la respuesta normal. Se declara siempre
 * el campo en vez de devolver 404 o un objeto vacío: quien pregunta necesita
 * poder distinguir "no está congelado" de "no pude averiguarlo".
 */
export interface WarehouseFreeze {
  warehouse_id: string;
  frozen: boolean;
  /** Folio del inventario físico que lo congela. `null` si no hay ninguno. */
  folio: string | null;
  count_id: string | null;
  status: string | null;
}

/** Lo que deja un movimiento entre ubicaciones. */
export interface MoveLotResult {
  moved: true;
  from_bin_id: string;
  to_bin_id: string;
  lot_code: string;
  quantity: number;
  /** Lo que queda del lote en el rack de origen. */
  queda_en_origen: number;
}

export interface MoveLotDto {
  warehouse_id: string;
  product_id: string;
  lot_code?: string;
  expiry_date?: string; // YYYY-MM-DD
  /** De dónde sale. Uno de los dos. */
  from_bin_id?: string;
  from_bin_code?: string;
  /** A dónde va. Uno de los dos. */
  to_bin_id?: string;
  to_bin_code?: string;
  quantity: number;
}

@Injectable()
export class BinLocationService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ───── bins ─────

  async createBin(dto: CreateBinDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (dto.aisle_id && !UUID.test(dto.aisle_id)) throw new BadRequestException('aisle_id inválido');
    const code = normalizeBinCode(dto.code);
    const label = String(dto.label ?? '').trim();
    if (label.length > LABEL_MAX)
      throw new BadRequestException(
        `El nombre no puede pasar de ${LABEL_MAX} caracteres (escribiste ${label.length}).`,
      );
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const wh = await trx('commercial.warehouses').where({ id: dto.warehouse_id }).first('id');
      if (!wh) throw new NotFoundException('Almacén no encontrado');
      if (dto.aisle_id) {
        const aisle = await trx('commercial.warehouse_aisles').where({ id: dto.aisle_id }).first('id');
        if (!aisle) throw new NotFoundException('Pasillo no encontrado');
      }
      // Duplicado sin importar mayúsculas: el UNIQUE de la tabla distingue
      // `r-12` de `R-12`, así que sin este `UPPER()` la base aceptaría dos
      // ubicaciones que en el cartel impreso se ven idénticas y que un escaneo no
      // podría desempatar. (Alcanza también a las filas anteriores al normalizador.)
      const dup = await trx('commercial.warehouse_bins')
        .where({ warehouse_id: dto.warehouse_id })
        .whereRaw('UPPER(code) = ?', [code])
        .first('id', 'code');
      if (dup) throw new ConflictException(`Ya existe la ubicación '${dup.code}' en ese almacén`);
      const [row] = await trx('commercial.warehouse_bins')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          aisle_id: dto.aisle_id || null,
          code,
          label: label || null,
          updated_by: userId,
        })
        .returning('*');
      return row;
    });
  }

  async listBins(warehouseId?: string) {
    if (warehouseId && !UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      let q = trx('commercial.warehouse_bins as b')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'b.tenant_id').andOn('w.id', '=', 'b.warehouse_id');
        });
      if (warehouseId) q = q.where('b.warehouse_id', warehouseId);
      return q
        .select(
          'b.id', 'b.warehouse_id', 'w.code as warehouse_code', 'b.aisle_id', 'b.code', 'b.label', 'b.active',
          trx.raw(`(SELECT COALESCE(SUM(quantity),0) FROM commercial.stock_lot_locations l WHERE l.bin_id = b.id) AS units`),
        )
        .orderBy('w.code')
        .orderBy('b.code');
    });
  }

  async deleteBin(id: string) {
    if (!UUID.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const used = await trx('commercial.stock_lot_locations').where({ bin_id: id }).where('quantity', '>', 0).first('id');
      if (used) throw new ConflictException('El bin tiene inventario ubicado; vacialo antes de eliminarlo');

      // Las filas en CERO se limpian acá, en la misma transacción.
      //
      // No son inventario —la línea de arriba ya probó que ninguna tiene cantidad—
      // pero la FK `fk_commercial_stock_lot_loc_bin` es `ON DELETE RESTRICT`, así
      // que existir alcanza para que el DELETE del bin reviente con 23503 y salga
      // como **500 pelado**. Antes no pasaba porque nada podía bajar una fila a
      // cero: `putAway` sólo sumaba. Con `moveLot` un rack se vacía de verdad, y
      // vaciarlo es justo el paso previo a darlo de baja.
      await trx('commercial.stock_lot_locations').where({ bin_id: id }).del();

      const n = await trx('commercial.warehouse_bins').where({ id }).del();
      if (!n) throw new NotFoundException('Bin no encontrado');
      return { deleted: true };
    });
  }

  // ───── put-away ─────

  async putAway(dto: PutAwayDto) {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID.test(dto.product_id)) throw new BadRequestException('product_id inválido');
    if (typeof dto.quantity !== 'number' || dto.quantity <= 0) throw new BadRequestException('quantity debe ser > 0');
    if (dto.expiry_date && !ISO_DATE.test(dto.expiry_date)) throw new BadRequestException('expiry_date debe ser YYYY-MM-DD');
    const lot = (dto.lot_code || 'NA').trim() || 'NA';
    const expiry = dto.expiry_date || null;

    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;

      // Resolver bin (por id o por code escaneado).
      let binId = dto.bin_id || null;
      if (!binId) {
        // Mismo normalizador que el alta: lo que se escanea y lo que se guardó
        // tienen que ser comparables. `UPPER()` además alcanza a las ubicaciones
        // creadas antes de que el servidor normalizara.
        const code = normalizeBinCode(dto.bin_code);
        const bin = await trx('commercial.warehouse_bins')
          .where({ warehouse_id: dto.warehouse_id })
          .whereRaw('UPPER(code) = ?', [code])
          .first('id');
        if (!bin) throw new NotFoundException(`No existe la ubicación '${code}' en ese almacén`);
        binId = bin.id;
      } else {
        if (!UUID.test(binId)) throw new BadRequestException('bin_id inválido');
        const bin = await trx('commercial.warehouse_bins').where({ id: binId, warehouse_id: dto.warehouse_id }).first('id');
        if (!bin) throw new NotFoundException('Bin no encontrado en ese almacén');
      }

      // El lote debe existir en stock_lots (recepción primero).
      const lotRow = await trx('commercial.stock_lots')
        .where({ warehouse_id: dto.warehouse_id, product_id: dto.product_id, lot_code: lot })
        .where((qb: any) => (expiry ? qb.where('expiry_date', expiry) : qb.whereNull('expiry_date')))
        .first('quantity');
      if (!lotRow) throw new ConflictException('El lote no existe en stock (recibí la mercancía primero)');

      // SUM(ubicado del lote) + quantity ≤ lote.quantity.
      const locatedRow = await trx('commercial.stock_lot_locations')
        .where({ warehouse_id: dto.warehouse_id, product_id: dto.product_id, lot_code: lot })
        .where((qb: any) => (expiry ? qb.where('expiry_date', expiry) : qb.whereNull('expiry_date')))
        .sum({ s: 'quantity' })
        .first();
      const located = Number(locatedRow?.s || 0);
      const lotQty = Number(lotRow.quantity);
      if (located + dto.quantity > lotQty) {
        throw new ConflictException(
          `No podés ubicar ${dto.quantity}: del lote quedan ${lotQty - located} por ubicar (lote ${lotQty}, ya ubicado ${located}).`,
        );
      }

      await trx.raw(
        `INSERT INTO commercial.stock_lot_locations
           (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id, quantity, updated_by)
         VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id)
         DO UPDATE SET quantity = commercial.stock_lot_locations.quantity + EXCLUDED.quantity,
                       updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [dto.warehouse_id, dto.product_id, lot, expiry, binId, dto.quantity, userId],
      );
      return { located: true, bin_id: binId, lot_code: lot, quantity: dto.quantity };
    });
  }

  /**
   * **Mover un lote de un rack a otro.**
   *
   * Faltaba, y su ausencia no era una comodidad de menos: `stock_lot_locations`
   * tenía **un solo escritor en todo el repo** —el `INSERT … quantity = quantity
   * + EXCLUDED.quantity` de `putAway`— o sea que el mapa de la bodega sólo sabía
   * SUMAR. Una vez acomodado, un lote quedaba clavado en ese rack para siempre;
   * la bodega se reacomoda todas las semanas y el mapa se iba quedando viejo sin
   * que nada lo dijera. Peor: como `putAway` topea en `SUM(ubicado) ≤
   * lote.quantity`, un rack que el sistema cree lleno **rechaza** mercancía nueva
   * de ese SKU aunque el espacio esté libre.
   *
   * **No toca existencia.** Ni `commercial.stock` ni `commercial.stock_lots`: el
   * total del almacén no cambia, cambia dónde está. Es la misma tesis de la capa
   * física — el saldo lo lleva el lote, la posición la lleva esta tabla.
   *
   * **Respeta el congelamiento del inventario físico**, a diferencia de fechar.
   * La distinción no es de gusto: fechar mueve una etiqueta y el conteo cuenta
   * por SKU, así que no puede alterar lo contado; mover mueve **la caja**, y el
   * conteo se organiza recorriendo ubicaciones (`inventory_count_items.location`).
   * Cambiar cajas de lugar a mitad de un recuento es exactamente lo que el
   * congelamiento existe para impedir.
   */
  async moveLot(dto: MoveLotDto): Promise<MoveLotResult> {
    if (!UUID.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID.test(dto.product_id)) throw new BadRequestException('product_id inválido');
    if (typeof dto.quantity !== 'number' || dto.quantity <= 0)
      throw new BadRequestException('quantity debe ser > 0');
    if (dto.expiry_date && !ISO_DATE.test(dto.expiry_date))
      throw new BadRequestException('expiry_date debe ser YYYY-MM-DD');

    const lot = (dto.lot_code || 'NA').trim() || 'NA';
    const expiry = dto.expiry_date || null;

    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;

      await this.assertNoCount(trx, dto.warehouse_id);

      const origen = await this.resolverBin(trx, dto.warehouse_id, dto.from_bin_id, dto.from_bin_code, 'origen');
      const destino = await this.resolverBin(trx, dto.warehouse_id, dto.to_bin_id, dto.to_bin_code, 'destino');
      if (origen === destino)
        throw new BadRequestException('El origen y el destino son la misma ubicación.');

      // Lo que hay del lote EN EL ORIGEN, bloqueado: sin el lock, dos handhelds
      // moviendo el mismo lote a la vez podrían sacar más de lo que hay.
      const fila = await trx('commercial.stock_lot_locations')
        .where({ warehouse_id: dto.warehouse_id, product_id: dto.product_id, lot_code: lot, bin_id: origen })
        .where((qb: Knex.QueryBuilder) => (expiry ? qb.where('expiry_date', expiry) : qb.whereNull('expiry_date')))
        .forUpdate()
        .first('id', 'quantity');

      const hay = Number(fila?.quantity || 0);
      if (hay <= 0)
        throw new ConflictException('En esa ubicación no hay nada de ese lote: revisá el rack de origen.');
      if (hay < dto.quantity)
        throw new ConflictException(
          `En el origen hay ${hay} de ese lote y querés mover ${dto.quantity}.`,
        );

      // Sale del origen. La fila se deja en 0 en vez de borrarla: es el rastro de
      // que ese lote estuvo ahí, y un 0 no bloquea borrar el bin (deleteBin sólo
      // frena con quantity > 0).
      await trx('commercial.stock_lot_locations')
        .where({ id: fila.id })
        .update({ quantity: hay - dto.quantity, updated_at: trx.fn.now(), updated_by: userId });

      // Entra al destino, con el mismo upsert que el put-away.
      await trx.raw(
        `INSERT INTO commercial.stock_lot_locations
           (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id, quantity, updated_by)
         VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id)
         DO UPDATE SET quantity = commercial.stock_lot_locations.quantity + EXCLUDED.quantity,
                       updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [dto.warehouse_id, dto.product_id, lot, expiry, destino, dto.quantity, userId],
      );

      return {
        moved: true,
        from_bin_id: origen,
        to_bin_id: destino,
        lot_code: lot,
        quantity: dto.quantity,
        queda_en_origen: hay - dto.quantity,
      };
    });
  }

  /**
   * Un bin de ESTE almacén, por id o por el código del cartel. `rol` sólo entra
   * en el mensaje: "no existe la ubicación de destino" se corrige distinto que
   * "no existe la de origen".
   */
  private async resolverBin(
    trx: Knex.Transaction,
    warehouseId: string,
    binId: string | undefined,
    binCode: string | undefined,
    rol: 'origen' | 'destino',
  ): Promise<string> {
    if (binId) {
      if (!UUID.test(binId)) throw new BadRequestException(`bin de ${rol} inválido`);
      const b = await trx('commercial.warehouse_bins')
        .where({ id: binId, warehouse_id: warehouseId })
        .first('id');
      if (!b) throw new NotFoundException(`La ubicación de ${rol} no es de este almacén.`);
      return b.id;
    }
    const code = normalizeBinCode(binCode);
    const b = await trx('commercial.warehouse_bins')
      .where({ warehouse_id: warehouseId })
      .whereRaw('UPPER(code) = ?', [code])
      .first('id');
    if (!b) throw new NotFoundException(`No existe la ubicación de ${rol} '${code}' en este almacén.`);
    return b.id;
  }

  /**
   * Frena si el almacén tiene un inventario físico congelando movimientos.
   *
   * Espeja `assertWarehouseNotFrozen` de `CommercialInventoryService` — se repite
   * la consulta en vez de inyectar ese servicio para no crear una dependencia
   * circular entre los dos módulos de inventario. Si el criterio cambia, cambia
   * en los dos lados: está dicho acá y allá.
   */
  private async assertNoCount(trx: Knex.Transaction, warehouseId: string): Promise<void> {
    const frozen = await trx('commercial.inventory_counts')
      .where({ warehouse_id: warehouseId, freeze_movements: true })
      .whereIn('status', ['open', 'counting', 'review', 'ready_to_reconcile'])
      .first('folio');
    if (frozen)
      throw new ConflictException(
        `Almacén con inventario físico en curso (folio ${frozen.folio}); no se puede mover mercancía de lugar hasta cerrar o cancelar el conteo.`,
      );
  }

  /**
   * **¿Se puede trabajar en este almacén?** — la pregunta que el Andén hacía
   * demasiado tarde.
   *
   * Hoy el congelamiento por inventario físico se descubre al GUARDAR: el
   * operario lee la etiqueta, teclea lote, caducidad y cantidad, aprieta, y
   * recién ahí el backend contesta que hay un conteo abierto. Con seis renglones
   * capturados, seis veces. El almacén se conoce desde que se identifica el vale,
   * así que la pregunta se puede hacer antes de que escriba la primera letra.
   *
   * Es una LECTURA: no frena nada por sí sola. Los que frenan de verdad siguen
   * siendo los guards del servidor (`assertNoCount` acá, `assertWarehouseNotFrozen`
   * en el servicio de inventario) — esto sólo permite decirlo a tiempo. Si esta
   * consulta fallara, el guard del guardado sigue siendo la red de seguridad.
   */
  async warehouseFreeze(warehouseId: string): Promise<WarehouseFreeze> {
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    return this.tk.run(async (trx) => {
      const frozen = await trx('commercial.inventory_counts')
        .where({ warehouse_id: warehouseId, freeze_movements: true })
        .whereIn('status', ['open', 'counting', 'review', 'ready_to_reconcile'])
        .first('id', 'folio', 'status');
      return {
        warehouse_id: warehouseId,
        frozen: !!frozen,
        folio: frozen?.folio ?? null,
        count_id: frozen?.id ?? null,
        status: frozen?.status ?? null,
      };
    });
  }

  // ───── reads ─────

  /**
   * **Escaneá el rack y decime qué tiene.** Resuelve el código impreso en el
   * cartel (CODE128) y devuelve la ubicación con su contenido en UNA llamada.
   *
   * Existe como endpoint propio y no como "buscá en la lista que ya bajaste"
   * por dos razones medidas:
   *  - el que escanea está con una pistola en la mano y **no eligió almacén**;
   *    `listBins` es por almacén, así que resolver del lado del navegador obliga
   *    a elegirlo antes, que es justo el paso que el escaneo viene a evitar;
   *  - `binContents` sólo acepta el UUID, y el cartel no lleva UUID: lleva el
   *    código. Sin esto, escanear un rack no tenía a dónde pegarle.
   *
   * **Si el mismo código existe en dos almacenes NO se adivina**: se devuelven
   * los candidatos para que la persona desempate (mismo criterio que el escaneo
   * de producto en Caducidades). Dos bodegas pueden tener su "R-12".
   */
  async lookupBin(rawCode: string, warehouseId?: string) {
    const code = normalizeBinCode(rawCode);
    if (warehouseId && !UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');

    return this.tk.run(async (trx) => {
      let q = trx('commercial.warehouse_bins as b')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'b.tenant_id').andOn('w.id', '=', 'b.warehouse_id');
        })
        .whereRaw('UPPER(b.code) = ?', [code]);
      if (warehouseId) q = q.where('b.warehouse_id', warehouseId);

      const hits = await q.select(
        'b.id', 'b.code', 'b.label', 'b.active', 'b.warehouse_id',
        'w.code as warehouse_code', 'w.name as warehouse_name',
      ).orderBy('w.code');

      if (!hits.length) {
        // **No es un error**: es la respuesta a "¿existe este rack?". Tirar 404
        // obligaría a la pantalla a distinguir un 404 de verdad (ruta mala) de
        // este, y a tratar un dato válido como excepción.
        return { code, match: null, candidates: [], contents: [], totals: null };
      }
      if (hits.length > 1) return { code, match: null, candidates: hits, contents: [], totals: null };

      const bin = hits[0];
      const contents = (await this.binContents(bin.id)) as BinContentRow[];
      return { code, match: bin, candidates: [], contents, totals: this.totalizar(contents) };
    });
  }

  /**
   * Resumen del rack, calculado sobre las MISMAS filas que se muestran.
   *
   * `vencidos` y `por_vencer` salen de `days_to_expiry`, que ya viene de la base
   * (`CURRENT_DATE`), no del reloj del navegador. Un lote **sin fecha** no cuenta
   * en ninguno de los dos: no se sabe, y contarlo como sano sería dibujarlo.
   */
  private totalizar(contents: BinContentRow[]) {
    let unidades = 0, vencidos = 0, porVencer = 0, sinFecha = 0;
    const skus = new Set<string>();
    for (const c of contents) {
      unidades += Number(c.quantity) || 0;
      if (c.product_id) skus.add(String(c.product_id));
      const d = c.days_to_expiry;
      if (d == null) sinFecha++;
      else if (Number(d) < 0) vencidos++;
      else if (Number(d) <= 30) porVencer++;
    }
    return { lineas: contents.length, productos: skus.size, unidades, vencidos, por_vencer: porVencer, sin_fecha: sinFecha };
  }

  /** Contenido de un bin: qué lotes y cuánto. */
  async binContents(binId: string) {
    if (!UUID.test(binId)) throw new BadRequestException('bin_id inválido');
    return this.tk.run(async (trx) =>
      trx('commercial.stock_lot_locations as l')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .where('l.bin_id', binId)
        .where('l.quantity', '>', 0)
        // `days_to_expiry` se calcula en la BASE, contra `CURRENT_DATE`: el mismo
        // reloj que fechó el lote. Calcularlo en el navegador de un handheld —que
        // puede tener la fecha corrida— pintaría un semáforo que no es.
        .select('l.id', 'l.product_id', 'p.sku', 'p.nombre as product_name', 'l.lot_code', 'l.expiry_date', 'l.quantity',
          trx.raw('(l.expiry_date - CURRENT_DATE)::int as days_to_expiry'))
        .orderByRaw('l.expiry_date ASC NULLS LAST'),
    );
  }

  /** Auxiliar de ubicaciones: dónde está cada lote (filtra por almacén/producto). */
  async locations(query: { warehouse_id?: string; product_id?: string }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (query.product_id && !UUID.test(query.product_id)) throw new BadRequestException('product_id inválido');
    return this.tk.run(async (trx) => {
      let q = trx('commercial.stock_lot_locations as l')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .leftJoin('commercial.warehouse_bins as b', function () {
          this.on('b.tenant_id', '=', 'l.tenant_id').andOn('b.id', '=', 'l.bin_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'l.tenant_id').andOn('w.id', '=', 'l.warehouse_id');
        })
        .where('l.quantity', '>', 0);
      if (query.warehouse_id) q = q.where('l.warehouse_id', query.warehouse_id);
      if (query.product_id) q = q.where('l.product_id', query.product_id);
      return q
        .select(
          'l.id', 'l.warehouse_id', 'w.code as warehouse_code',
          'l.product_id', 'p.sku', 'p.nombre as product_name',
          'l.lot_code', 'l.expiry_date', 'l.bin_id', 'b.code as bin_code', 'b.label as bin_label', 'l.quantity',
          trx.raw('(l.expiry_date - CURRENT_DATE)::int as days_to_expiry'),
        )
        .orderBy('p.nombre')
        .orderByRaw('l.expiry_date ASC NULLS LAST')
        .limit(1000);
    });
  }

  /** Lotes con cantidad por ubicar (stock_lots.quantity − SUM ubicado > 0). */
  async unlocated(query: { warehouse_id?: string; product_id?: string }) {
    if (query.warehouse_id && !UUID.test(query.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (query.product_id && !UUID.test(query.product_id)) throw new BadRequestException('product_id inválido');
    return this.tk.run(async (trx) => {
      const params: any[] = [];
      let where = 'sl.quantity > 0';
      if (query.warehouse_id) { where += ' AND sl.warehouse_id = ?'; params.push(query.warehouse_id); }
      if (query.product_id) { where += ' AND sl.product_id = ?'; params.push(query.product_id); }
      const res = await trx.raw(
        `SELECT sl.warehouse_id, w.code AS warehouse_code, sl.product_id, p.sku, p.nombre AS product_name,
                sl.lot_code, sl.expiry_date, sl.quantity AS lot_qty,
                COALESCE((SELECT SUM(loc.quantity) FROM commercial.stock_lot_locations loc
                           WHERE loc.warehouse_id = sl.warehouse_id AND loc.product_id = sl.product_id
                             AND loc.lot_code = sl.lot_code AND loc.expiry_date IS NOT DISTINCT FROM sl.expiry_date), 0) AS located,
                sl.quantity - COALESCE((SELECT SUM(loc.quantity) FROM commercial.stock_lot_locations loc
                           WHERE loc.warehouse_id = sl.warehouse_id AND loc.product_id = sl.product_id
                             AND loc.lot_code = sl.lot_code AND loc.expiry_date IS NOT DISTINCT FROM sl.expiry_date), 0) AS to_locate
           FROM commercial.stock_lots sl
           LEFT JOIN public.products p ON p.id = sl.product_id
           LEFT JOIN commercial.warehouses w ON w.tenant_id = sl.tenant_id AND w.id = sl.warehouse_id
          WHERE ${where}
          ORDER BY p.nombre, sl.expiry_date ASC NULLS LAST`,
        params,
      );
      return res.rows.filter((r: any) => Number(r.to_locate) > 0);
    });
  }

  /** FEFO físico: bins con este producto, ordenados por caducidad ascendente (surtí primero el 1º). */
  async pickSuggestion(warehouseId: string, productId: string) {
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID.test(productId)) throw new BadRequestException('product_id inválido');
    return this.tk.run(async (trx) =>
      trx('commercial.stock_lot_locations as l')
        .leftJoin('commercial.warehouse_bins as b', function () {
          this.on('b.tenant_id', '=', 'l.tenant_id').andOn('b.id', '=', 'l.bin_id');
        })
        .where({ 'l.warehouse_id': warehouseId, 'l.product_id': productId })
        .where('l.quantity', '>', 0)
        .select('l.bin_id', 'b.code as bin_code', 'b.label as bin_label', 'l.lot_code', 'l.expiry_date', 'l.quantity',
          trx.raw('(l.expiry_date - CURRENT_DATE)::int as days_to_expiry'))
        .orderByRaw('l.expiry_date ASC NULLS LAST')
        .limit(50),
    );
  }
}
