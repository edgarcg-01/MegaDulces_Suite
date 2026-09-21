import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, todayMx } from '@megadulces/platform-core';

/**
 * `[FLT.3]` — LISTA DE FALTANTES: la venta que NO ocurrió, reportada desde el piso.
 *
 * ── Por qué este servicio existe ─────────────────────────────────────────────────────────────
 * Todo lo demás en esta suite se deriva del ERP. Esto no puede: **una venta que no pasó no deja
 * rastro en ninguna fuente.** No hay ticket, no hay movimiento, no hay renglón en `kepler_ods`.
 * El cliente preguntó, no lo había, y se fue. El único instrumento capaz de registrar ese hecho
 * es la persona que estaba en el mostrador — por eso hay captura humana y por eso hay tabla
 * propia (`commercial.floor_stockouts`), que es la excepción que la regla del ODS nombra.
 *
 * ── Lo que SÍ se deriva, y se guarda como snapshot ───────────────────────────────────────────
 * Al momento de reportar se leen dos cosas de las vistas canónicas, y **no se re-derivan acá**
 * (un primitivo con dos implementaciones es un primitivo que va a divergir):
 *
 *   · existencia → `analytics.v_erp_stock_on_hand`  (la vista que mide 100% contra el POS; la
 *     tabla `commercial.stock` acierta 91% y por eso NO se usa — ver `existencia.service.ts`)
 *   · precio     → `analytics.v_label_prices`       (el MISMO precio que muestran la etiqueta y
 *     el verificador, así que la valoración es conmensurable con lo que el cliente vio)
 *
 * `on_hand_at_report` es el que convierte esto en dos señales y no en una:
 *
 *   > La persona vio CERO. Si el ERP dice 12, eso **no es un aviso de compra: es un descuadre de
 *   > inventario**. Guardar lo que el sistema creía en ese instante es lo único que permite
 *   > separarlos después, y no se puede reconstruir a posteriori porque la existencia cambia.
 *
 * ── Valorar lo no vendido ────────────────────────────────────────────────────────────────────
 * `est_lost_revenue = piece_price × times_reported`. Es una **estimación para priorizar**, no una
 * cifra contable, y viaja etiquetada en `est_source`. Cuando no hay precio con qué valorar queda
 * **NULL con `est_source='sin_dato'`**, nunca $0 — un cero dibujado se lee como "no vale nada",
 * que es la conclusión contraria a la verdadera (ADR-056). El CHECK de la tabla lo hace imposible
 * de violar aunque este código se equivoque.
 *
 * ⚠️ La unidad de la estimación es la PIEZA, porque `piece_price` lo es. No se multiplica por
 * ningún factor de caja: el catálogo discrepa con el ERP en el factor y meterlo acá inventaría
 * precisión que el dato no tiene (ADR-055 / `UNIDADES_DE_MEDIDA.md`).
 *
 * ── Grano semanal ────────────────────────────────────────────────────────────────────────────
 * Una fila por (sucursal, motivo, cosa, semana) con contador. Si el mismo producto lo piden nueve
 * veces, la señal es el NUEVE, no nueve renglones. UPSERT idempotente por `(tenant_id, dedup_key)`
 * — mismo patrón que `receiving_claims` (WMS-REC.8) y `replenishment_findings` (RA.8).
 *
 * ── Sin sesión ───────────────────────────────────────────────────────────────────────────────
 * El kiosco de mostrador corre sin cuenta de persona (igual que el verificador, `[CV.24]`). Por
 * eso la sucursal llega SIEMPRE explícita y nunca se deduce del usuario, y `reported_by` puede ser
 * NULL. Pedir login mataría los cinco segundos que este flujo tiene para existir.
 *
 * Conexión: `TenantKnexService.run()` es OBLIGATORIO — la tabla tiene RLS forzado y sin el
 * `SET LOCAL app.tenant_id` toda consulta devuelve cero filas en silencio (lección de la Fase E).
 */

export type StockoutKind = 'agotado' | 'no_en_sucursal' | 'no_en_catalogo' | 'codigo_no_pasa';
export type StockoutSource = 'verificador' | 'almacen' | 'caja' | 'otro';
export type StockoutStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
export type StockoutDecision =
  | 'alta_catalogo'
  | 'ya_en_camino'
  | 'no_se_trabaja'
  | 'codigo_corregido'
  | 'era_error';

const KINDS: readonly StockoutKind[] = ['agotado', 'no_en_sucursal', 'no_en_catalogo', 'codigo_no_pasa'];
const SOURCES: readonly StockoutSource[] = ['verificador', 'almacen', 'caja', 'otro'];
const DECISIONS: readonly StockoutDecision[] = [
  'alta_catalogo', 'ya_en_camino', 'no_se_trabaja', 'codigo_corregido', 'era_error',
];

export interface ReportarDto {
  /** Código de sucursal (`'03'`, `'MD-30'`). Explícito SIEMPRE: el kiosco no tiene sesión. */
  warehouse_code: string;
  kind: StockoutKind;
  /** Lo que leyó el lector. Puede no resolver a ningún producto — ése es justamente un caso. */
  scanned_code?: string;
  /** Clave del producto, si la pantalla ya lo resolvió. */
  sku?: string;
  /** Lo que escribió la persona cuando no hay producto que resolver. */
  product_name?: string;
  source?: StockoutSource;
}

/** Mensaje de un error de origen desconocido, sin `any` y sin romper si no es `Error`. */
function motivoDe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * La fila cruda como la devuelve Postgres. Los numéricos llegan como **string** por el driver
 * (`numeric` no entra en un `number` de JS sin perder precisión), así que se tipan como la unión
 * y se convierten en un solo lugar (`mapear`) en vez de en cada consumidor.
 */
interface FilaFaltante {
  id: string;
  kind: StockoutKind;
  sku?: string | null;
  scanned_code?: string | null;
  product_name?: string | null;
  times_reported: number | string;
  week_start: string;
  first_reported_at?: string | null;
  last_reported_at: string;
  on_hand_at_report: number | string | null;
  est_lost_revenue: number | string | null;
  est_source: 'precio_erp' | 'sin_dato';
  status: StockoutStatus;
  decision?: StockoutDecision | null;
  decision_note?: string | null;
  decided_by_username?: string | null;
  reported_by_username?: string | null;
  source?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
}

/** Un faltante como lo lee la pantalla. Forma única para la bandeja y para la sucursal. */
export interface FaltanteSalida {
  id: string;
  kind: StockoutKind;
  sku: string | null;
  scanned_code: string | null;
  product_name: string | null;
  times_reported: number;
  week_start: string;
  first_reported_at: string | null;
  last_reported_at: string;
  on_hand_at_report: number | null;
  est_lost_revenue: number | null;
  est_source: 'precio_erp' | 'sin_dato';
  status: StockoutStatus;
  decision: StockoutDecision | null;
  decision_note: string | null;
  decided_by_username: string | null;
  reported_by_username: string | null;
  source: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  contradice_al_erp: boolean;
}

/** Un renglón de la herramienta de caja: qué código falla y cuántas veces. */
export interface CodigoQueFalla {
  sku: string | null;
  scanned_code: string | null;
  product_name: string | null;
  veces: number;
  ultima_vez: string;
}

/** Los KPI de la bandeja. `abiertos_sin_valorar` se cuenta aparte, nunca se suma como $0. */
export interface ResumenFaltantes {
  abiertos: number;
  abiertos_sin_valorar: number;
  dinero_estimado: number;
  no_en_catalogo: number;
  contradicen_al_erp: number;
}

export interface ReportarResult {
  id: string;
  kind: StockoutKind;
  /** Cuántas veces van en la semana. Es lo que la pantalla le devuelve a la persona. */
  times_reported: number;
  product_name: string | null;
  /** Lo que el ERP creía. `null` = no se pudo leer, y se DECLARA como tal. */
  on_hand_at_report: number | null;
  est_lost_revenue: number | null;
  est_source: 'precio_erp' | 'sin_dato';
  /**
   * `true` cuando la persona reportó agotado y el ERP dice que sí hay. No es un error del
   * reporte: es el hallazgo. La pantalla lo muestra y la bandeja lo rutea a inventario.
   */
  contradice_al_erp: boolean;
}

@Injectable()
export class FloorStockoutsService {
  private readonly logger = new Logger(FloorStockoutsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Lunes de la semana de una fecha `YYYY-MM-DD`.
   *
   * Se construye con `Date.UTC` y se formatea a mano a propósito: `new Date('2026-09-19')` se
   * interpreta como medianoche UTC y al renderizarlo en hora de México (−06:00) devuelve **el día
   * anterior**. Ese error exacto ya se pagó en la Fase LC, donde una factura del día 1 salía
   * fechada el 31 en el TXT, en el respaldo y en el orden de los renglones. Acá el insumo ya es
   * una fecha de México (`todayMx()`), así que sólo hay que no re-interpretarla.
   */
  private lunesDeLaSemana(fechaMx: string): string {
    const [y, m, d] = fechaMx.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d);
    const dow = new Date(t).getUTCDay();          // 0=domingo
    const aLunes = dow === 0 ? 6 : dow - 1;       // el domingo pertenece a la semana que ya terminó
    const lunes = new Date(t - aLunes * 86400000);
    return [
      lunes.getUTCFullYear(),
      String(lunes.getUTCMonth() + 1).padStart(2, '0'),
      String(lunes.getUTCDate()).padStart(2, '0'),
    ].join('-');
  }

  /** Normaliza lo escrito a mano para que "Chicle Rosa " y "chicle rosa" sean el mismo reporte. */
  private normalizarTexto(s: string): string {
    return s
      .normalize('NFD').replace(/[̀-ͯ]/g, '')   // sin acentos
      .toUpperCase().replace(/\s+/g, ' ').trim();
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // CAPTURA
  // ───────────────────────────────────────────────────────────────────────────────────────────

  async reportar(dto: ReportarDto): Promise<ReportarResult> {
    if (!dto?.warehouse_code) throw new BadRequestException('Falta la sucursal');
    if (!KINDS.includes(dto.kind)) {
      throw new BadRequestException(`Motivo inválido: ${dto.kind}. Válidos: ${KINDS.join(', ')}`);
    }
    const source: StockoutSource = SOURCES.includes(dto.source as StockoutSource)
      ? (dto.source as StockoutSource)
      : 'verificador';

    const sku = dto.sku?.trim() || null;
    const code = dto.scanned_code?.trim() || null;
    const escrito = dto.product_name?.trim() || null;

    // Lo que identifica la cosa reportada. Sin nada de esto el reporte no dice qué faltó.
    if (!sku && !code && !escrito) {
      throw new BadRequestException(
        'Hace falta el producto: una clave, un código escaneado o el nombre escrito a mano',
      );
    }

    const ctx = this.tenantCtx.get();
    const hoy = todayMx();
    const weekStart = this.lunesDeLaSemana(hoy);

    return this.tk.run(async (trx) => {
      // 1) Sucursal. Explícita y validada: un reporte contra una sucursal que no existe es
      //    un reporte perdido, y el FK lo rechazaría con un error ilegible para el mostrador.
      const wh = await trx('commercial.warehouses')
        .select('id', 'code', 'name')
        .whereRaw('LOWER(code) = LOWER(?)', [dto.warehouse_code])
        .whereNull('deleted_at')
        .first();
      if (!wh) throw new NotFoundException(`No existe la sucursal ${dto.warehouse_code}`);

      // 2) ¿Resuelve a un producto del catálogo? Para `no_en_catalogo` NI SE INTENTA: ese motivo
      //    afirma que el producto no es nuestro, y el CHECK de la tabla lo exige sin product_id.
      let producto: { id: string; sku: string; name: string } | null = null;
      if (dto.kind !== 'no_en_catalogo' && (sku || code)) {
        producto = await this.resolverProducto(trx, sku, code);
      }

      // 3) Snapshots derivados. Cada uno puede fallar sin tumbar el reporte: perder el faltante
      //    por no poder valorarlo sería cambiar el dato irrecuperable por el reconstruible.
      let onHand: number | null = null;
      let piecePrice: number | null = null;
      if (producto) {
        onHand = await this.leerExistencia(trx, wh.id, producto.id);
        piecePrice = await this.leerPrecio(trx, wh.code, producto.sku);
      }

      // 4) La identidad del reporte en la semana.
      const cosa = producto
        ? `sku:${producto.sku}`
        : code
          ? `code:${code}`
          : `txt:${this.normalizarTexto(escrito as string)}`;
      const dedupKey = `${wh.code}|${dto.kind}|${cosa}|${weekStart}`;

      const unitPrice = piecePrice != null && piecePrice > 0 ? piecePrice : null;
      const estSource: 'precio_erp' | 'sin_dato' = unitPrice != null ? 'precio_erp' : 'sin_dato';

      // 5) UPSERT. En conflicto el contador sube y la valoración se RECALCULA sobre el contador
      //    nuevo — si se dejara el valor viejo, nueve reportes valdrían lo mismo que uno.
      const { rows } = await trx.raw(
        `INSERT INTO commercial.floor_stockouts (
            tenant_id, warehouse_id, product_id, sku, scanned_code, product_name,
            kind, week_start, times_reported, source,
            reported_by, reported_by_username,
            on_hand_at_report, unit_price, est_lost_revenue, est_source, dedup_key
         ) VALUES (
            public.current_tenant_id(), ?, ?, ?, ?, ?,
            ?, ?, 1, ?,
            ?, ?,
            ?, ?, ?, ?, ?
         )
         ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET
            times_reported   = commercial.floor_stockouts.times_reported + 1,
            last_reported_at = now(),
            updated_at       = now(),
            -- La existencia y el precio se refrescan: el reporte más nuevo es el que vale.
            on_hand_at_report = COALESCE(EXCLUDED.on_hand_at_report, commercial.floor_stockouts.on_hand_at_report),
            unit_price        = COALESCE(EXCLUDED.unit_price, commercial.floor_stockouts.unit_price),
            est_lost_revenue  = CASE
              WHEN COALESCE(EXCLUDED.unit_price, commercial.floor_stockouts.unit_price) IS NOT NULL
                THEN ROUND(COALESCE(EXCLUDED.unit_price, commercial.floor_stockouts.unit_price)
                           * (commercial.floor_stockouts.times_reported + 1), 2)
              ELSE NULL END,
            est_source        = CASE
              WHEN COALESCE(EXCLUDED.unit_price, commercial.floor_stockouts.unit_price) IS NOT NULL
                THEN 'precio_erp' ELSE 'sin_dato' END
         RETURNING id, kind, times_reported, product_name, on_hand_at_report,
                   est_lost_revenue, est_source`,
        [
          wh.id, producto?.id ?? null, producto?.sku ?? sku, code,
          producto?.name ?? escrito,
          dto.kind, weekStart, source,
          ctx?.userId ?? null, ctx?.username ?? null,
          onHand, unitPrice,
          unitPrice != null ? Number((unitPrice * 1).toFixed(2)) : null,
          estSource, dedupKey,
        ],
      );

      const r = rows[0];
      const onHandNum = r.on_hand_at_report != null ? Number(r.on_hand_at_report) : null;

      return {
        id: r.id,
        kind: r.kind,
        times_reported: Number(r.times_reported),
        product_name: r.product_name ?? null,
        on_hand_at_report: onHandNum,
        est_lost_revenue: r.est_lost_revenue != null ? Number(r.est_lost_revenue) : null,
        est_source: r.est_source,
        // El hallazgo: dijo que no hay y el ERP dice que sí. Va a inventario, no a compras.
        contradice_al_erp: r.kind === 'agotado' && onHandNum != null && onHandNum > 0,
      };
    });
  }

  /**
   * Producto por clave o por código escaneado.
   *
   * El código se busca en `catalog.product_barcodes`, que es el 1→N real (un SKU tiene un código
   * por UNIDAD: pieza, paquete, caja). `catalog.products.barcode` es escalar y sólo trae el de la
   * pieza — buscar ahí haría "no existe" a todo lo que se escanea por caja.
   */
  private async resolverProducto(
    trx: Knex.Transaction, sku: string | null, code: string | null,
  ): Promise<{ id: string; sku: string; name: string } | null> {
    // ⚠️ La columna del nombre es `nombre`, no `name`: `catalog.products` conserva el nombrado en
    // español del esquema legado (igual que `activo`, que además es GENERATED y nunca se escribe).
    // Se alias-ea a `name` acá para que el resto del servicio hable un solo idioma.
    if (sku) {
      const p = await trx('catalog.products')
        .select('id', 'sku', 'nombre as name')
        .whereRaw('BTRIM(sku) = BTRIM(?)', [sku])
        .whereNull('deleted_at')
        .first();
      if (p) return p;
    }
    if (code) {
      // Sin ceros a la izquierda: el lector y Kepler no siempre coinciden en el pad (misma
      // normalización que usa el verificador en `unidadDelCodigo`).
      const p = await trx('catalog.product_barcodes as b')
        .join('catalog.products as p', function (this: Knex.JoinClause) {
          this.on('p.tenant_id', '=', 'b.tenant_id').andOn(trx.raw('BTRIM(p.sku) = BTRIM(b.sku)'));
        })
        .select('p.id', 'p.sku', 'p.nombre as name')
        .whereRaw("LTRIM(BTRIM(b.barcode), '0') = LTRIM(BTRIM(?), '0')", [code])
        .whereNull('b.deleted_at')
        .whereNull('p.deleted_at')
        .first();
      if (p) return p;

      // Último intento: que el código escaneado SEA la clave del producto (pasa con los
      // internos de 5 dígitos que la gente teclea).
      const q = await trx('catalog.products')
        .select('id', 'sku', 'nombre as name')
        .whereRaw("LTRIM(BTRIM(sku), '0') = LTRIM(BTRIM(?), '0')", [code])
        .whereNull('deleted_at')
        .first();
      if (q) return q;
    }
    return null;
  }

  /** Existencia del ERP. `null` = no se pudo leer, y eso se DECLARA (nunca 0). */
  private async leerExistencia(trx: Knex.Transaction, warehouseId: string, productId: string): Promise<number | null> {
    try {
      const r = await trx('analytics.v_erp_stock_on_hand')
        .select('qty_stock_units')
        .where({ warehouse_id: warehouseId, product_id: productId })
        .first();
      return r?.qty_stock_units != null ? Number(r.qty_stock_units) : null;
    } catch (e: unknown) {
      this.logger.warn(`No se pudo leer existencia para valorar el faltante: ${motivoDe(e)}`);
      return null;
    }
  }

  /** Precio de pieza, el mismo que ve el cliente en la etiqueta. `null` = no se puede valorar. */
  private async leerPrecio(trx: Knex.Transaction, warehouseCode: string, sku: string): Promise<number | null> {
    try {
      const r = await trx('analytics.v_label_prices')
        .select('piece_price')
        .whereRaw('BTRIM(sucursal) = BTRIM(?)', [warehouseCode])
        .whereRaw('BTRIM(sku) = BTRIM(?)', [sku])
        .first();
      return r?.piece_price != null ? Number(r.piece_price) : null;
    } catch (e: unknown) {
      this.logger.warn(`No se pudo leer precio para valorar el faltante: ${motivoDe(e)}`);
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // LECTURA — TIENDA
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /** Lo reportado en una sucursal. Es lo que el encargado revisa. */
  async listarPorSucursal(warehouseCode: string, opts: { semanas?: number } = {}): Promise<FaltanteSalida[]> {
    if (!warehouseCode) throw new BadRequestException('Falta la sucursal');
    const semanas = Math.min(Math.max(Number(opts.semanas) || 4, 1), 26);
    const desde = this.lunesDeLaSemana(todayMx());

    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.floor_stockouts as f')
        .join('commercial.warehouses as w', function (this: Knex.JoinClause) {
          this.on('w.id', '=', 'f.warehouse_id').andOn('w.tenant_id', '=', 'f.tenant_id');
        })
        .select(
          'f.id', 'f.kind', 'f.sku', 'f.scanned_code', 'f.product_name',
          'f.times_reported', 'f.week_start', 'f.last_reported_at',
          'f.on_hand_at_report', 'f.est_lost_revenue', 'f.est_source',
          'f.status', 'f.decision', 'f.decision_note', 'f.reported_by_username',
        )
        .whereRaw('LOWER(w.code) = LOWER(?)', [warehouseCode])
        .whereRaw("f.week_start > (?::date - (? * 7))", [desde, semanas])
        .orderBy([{ column: 'f.week_start', order: 'desc' }, { column: 'f.times_reported', order: 'desc' }]);

      return rows.map((r: FilaFaltante) => this.mapear(r));
    });
  }

  /**
   * `[FLT.7]` LA HERRAMIENTA DE CAJA — los códigos que más fallan al escanear en esta plaza.
   *
   * ⚠️ Esta lista NO es "los productos sin código de barras". Eso se midió (2026-09-19) y son
   * **139 SKUs = 1.5% del catálogo** que valen **0.01% de la venta** de 90 días ($3,130 de
   * $45.7M) — y la mayoría ni son mercancía: códigos de promoción, etiquetas de anaquel, un
   * ajuste contable. Una hoja con esos renglones no le ahorra una sola búsqueda a la cajera.
   *
   * La lista útil es ésta: la de los códigos que **de verdad fallan**, medida por frecuencia real
   * en SU sucursal. Sale de lo que pasó, no de lo que el catálogo declara.
   */
  async codigosQueFallan(warehouseCode: string, limite = 50): Promise<CodigoQueFalla[]> {
    if (!warehouseCode) throw new BadRequestException('Falta la sucursal');
    const lim = Math.min(Math.max(Number(limite) || 50, 1), 200);

    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.floor_stockouts as f')
        .join('commercial.warehouses as w', function (this: Knex.JoinClause) {
          this.on('w.id', '=', 'f.warehouse_id').andOn('w.tenant_id', '=', 'f.tenant_id');
        })
        .select('f.sku', 'f.scanned_code', 'f.product_name')
        .sum({ veces: 'f.times_reported' })
        .max({ ultima_vez: 'f.last_reported_at' })
        .where('f.kind', 'codigo_no_pasa')
        .whereRaw('LOWER(w.code) = LOWER(?)', [warehouseCode])
        .groupBy('f.sku', 'f.scanned_code', 'f.product_name')
        .orderBy('veces', 'desc')
        .limit(lim);

      // `veces` viene del SUM: Postgres lo entrega como string y hay que convertirlo, o la
      // pantalla ordenaría "10" antes que "9" al compararlos como texto.
      type FilaAgrupada = {
        sku: string | null; scanned_code: string | null; product_name: string | null;
        veces: number | string; ultima_vez: string;
      };
      return rows.map((r: FilaAgrupada) => ({
        sku: r.sku ?? null,
        scanned_code: r.scanned_code ?? null,
        product_name: r.product_name ?? null,
        veces: Number(r.veces),
        ultima_vez: r.ultima_vez,
      }));
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // LECTURA + DECISIÓN — COMPRAS
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * La bandeja de Compras. Ordenada por dinero estimado, con lo no valorado AL FINAL:
   * encabezar la cola con lo que no se pudo medir sería premiar la falta de dato.
   */
  async bandeja(opts: { status?: string; kind?: string; warehouse_code?: string; limite?: number } = {}): Promise<FaltanteSalida[]> {
    const lim = Math.min(Math.max(Number(opts.limite) || 200, 1), 1000);

    return this.tk.run(async (trx) => {
      const q = trx('commercial.floor_stockouts as f')
        .join('commercial.warehouses as w', function (this: Knex.JoinClause) {
          this.on('w.id', '=', 'f.warehouse_id').andOn('w.tenant_id', '=', 'f.tenant_id');
        })
        .select(
          'f.id', 'f.kind', 'f.sku', 'f.scanned_code', 'f.product_name',
          'f.times_reported', 'f.week_start', 'f.first_reported_at', 'f.last_reported_at',
          'f.on_hand_at_report', 'f.est_lost_revenue', 'f.est_source',
          'f.status', 'f.decision', 'f.decision_note', 'f.decided_by_username',
          'f.reported_by_username', 'f.source',
          'w.code as warehouse_code', 'w.name as warehouse_name',
        )
        .orderByRaw('f.est_lost_revenue DESC NULLS LAST')
        .orderBy('f.times_reported', 'desc')
        .limit(lim);

      // Por default la bandeja muestra lo que hay que TRABAJAR, no el archivo histórico.
      if (opts.status) q.where('f.status', opts.status);
      else q.whereIn('f.status', ['open', 'in_progress']);

      if (opts.kind) q.where('f.kind', opts.kind);
      if (opts.warehouse_code) q.whereRaw('LOWER(w.code) = LOWER(?)', [opts.warehouse_code]);

      const rows = await q;
      return rows.map((r: FilaFaltante) => this.mapear(r));
    });
  }

  /** Resumen para los KPI de la bandeja. Lo no valorado se CUENTA aparte, no se suma como 0. */
  async resumen(): Promise<ResumenFaltantes> {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT
            count(*) FILTER (WHERE status IN ('open','in_progress'))          AS abiertos,
            count(*) FILTER (WHERE status IN ('open','in_progress')
                               AND est_source = 'sin_dato')                   AS abiertos_sin_valorar,
            COALESCE(sum(est_lost_revenue) FILTER (WHERE status IN ('open','in_progress')), 0) AS dinero_estimado,
            count(*) FILTER (WHERE status IN ('open','in_progress')
                               AND kind = 'no_en_catalogo')                   AS no_en_catalogo,
            count(*) FILTER (WHERE status IN ('open','in_progress')
                               AND kind = 'agotado'
                               AND on_hand_at_report > 0)                     AS contradicen_al_erp
           FROM commercial.floor_stockouts`,
      );
      const r = rows[0];
      return {
        abiertos: Number(r.abiertos),
        /** Cuántos de los abiertos NO se pudieron valorar. Se declara para no leer el total como completo. */
        abiertos_sin_valorar: Number(r.abiertos_sin_valorar),
        dinero_estimado: Number(r.dinero_estimado),
        no_en_catalogo: Number(r.no_en_catalogo),
        /** Dijeron "no hay" y el ERP dice que sí: descuadre de inventario, no compra. */
        contradicen_al_erp: Number(r.contradicen_al_erp),
      };
    });
  }

  /**
   * La decisión del comprador. Es la mitad que hace que el módulo sobreviva: si la cajera reporta
   * y nunca sabe qué pasó, deja de reportar en dos semanas. Medido en la landing de esta misma
   * suite, hay bandejas con **0 resueltas en 30 días** — nacen congeladas cuando no tienen dueño.
   */
  async decidir(id: string, dto: { decision: StockoutDecision; nota?: string }): Promise<{ id: string; status: StockoutStatus; decision: StockoutDecision }> {
    if (!DECISIONS.includes(dto?.decision)) {
      throw new BadRequestException(`Decisión inválida. Válidas: ${DECISIONS.join(', ')}`);
    }
    // `no_se_trabaja` es la única que le cierra la puerta a un producto: exige el porqué escrito,
    // porque es la respuesta que la sucursal va a recibir y "no" a secas no se puede rebatir.
    if (dto.decision === 'no_se_trabaja' && !dto.nota?.trim()) {
      throw new BadRequestException('Para "no se trabaja" hay que escribir el motivo: es lo que va a leer la sucursal');
    }

    const ctx = this.tenantCtx.get();
    // `era_error` archiva (no fue un faltante real); el resto resuelve.
    const status: StockoutStatus = dto.decision === 'era_error' ? 'dismissed' : 'resolved';

    return this.tk.run(async (trx) => {
      const n = await trx('commercial.floor_stockouts')
        .where({ id })
        .update({
          status,
          decision: dto.decision,
          decision_note: dto.nota?.trim() || null,
          decided_at: trx.fn.now(),
          decided_by: ctx?.userId ?? null,
          decided_by_username: ctx?.username ?? null,
          updated_at: trx.fn.now(),
        });
      if (!n) throw new NotFoundException('No existe ese reporte de faltante');
      return { id, status, decision: dto.decision };
    });
  }

  /** Forma única de la fila hacia la pantalla — para que bandeja y sucursal no diverjan. */
  private mapear(r: FilaFaltante): FaltanteSalida {
    const onHand = r.on_hand_at_report != null ? Number(r.on_hand_at_report) : null;
    return {
      id: r.id,
      kind: r.kind as StockoutKind,
      sku: r.sku ?? null,
      scanned_code: r.scanned_code ?? null,
      product_name: r.product_name ?? null,
      times_reported: Number(r.times_reported),
      week_start: r.week_start,
      first_reported_at: r.first_reported_at ?? null,
      last_reported_at: r.last_reported_at,
      on_hand_at_report: onHand,
      est_lost_revenue: r.est_lost_revenue != null ? Number(r.est_lost_revenue) : null,
      est_source: r.est_source,
      status: r.status as StockoutStatus,
      decision: r.decision ?? null,
      decision_note: r.decision_note ?? null,
      decided_by_username: r.decided_by_username ?? null,
      reported_by_username: r.reported_by_username ?? null,
      source: r.source ?? null,
      warehouse_code: r.warehouse_code ?? null,
      warehouse_name: r.warehouse_name ?? null,
      contradice_al_erp: r.kind === 'agotado' && onHand != null && onHand > 0,
    };
  }
}
