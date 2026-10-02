import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, todayMx } from '@megadulces/platform-core';

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

// `[FLT.21]` La regla del destino vive en un modulo PURO para poder probarse sin base de datos.
// Se re-exporta desde aca para no romper a quien ya importa del servicio.
export { destinoDe, STOCKOUT_KINDS } from './stockout-destino';
export type { StockoutKind, StockoutDestino } from './stockout-destino';
import { destinoDe, STOCKOUT_KINDS, type StockoutKind, type StockoutDestino } from './stockout-destino';

export type StockoutSource = 'verificador' | 'almacen' | 'caja' | 'otro';
export type StockoutStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
export type StockoutDecision =
  | 'alta_catalogo'
  | 'ya_en_camino'
  | 'no_se_trabaja'
  | 'codigo_corregido'
  | 'era_error';

const KINDS = STOCKOUT_KINDS;
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
  /** A quién le toca. Derivado de (kind, existencia) — ver `destinoDe`. */
  destino: StockoutDestino;
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
  /**
   * `[FLT.21]` Lo que se recupera **hoy**: hay existencia y no estaba en el anaquel. Va primero
   * en la pantalla porque es la única fila de la bandeja cuya venta todavía no se perdió.
   */
  recuperable_hoy: number;
  /** El dinero de esa fila, aparte del total: es el que se salva caminando a la bodega. */
  dinero_recuperable_hoy: number;
}

/**
 * `[FLT.22]` Lo que contesta la consulta «¿lo tenemos?». Dos formas, porque "no está en el
 * catálogo" y "está y no hay" mandan a la persona a hacer cosas distintas.
 */
export type ConsultaResultado =
  | {
      encontrado: false;
      termino: string;
      warehouse_code: string;
      warehouse_name: string | null;
    }
  | {
      encontrado: true;
      termino: string;
      warehouse_code: string;
      warehouse_name: string | null;
      sku: string;
      product_name: string;
      /** `null` = no se pudo leer el precio; la pantalla lo declara, no dibuja $0. */
      precio: number | null;
      /** `null` = NO SE PUDO MEDIR. Nunca 0 por defecto (ADR-056). */
      existencia: number | null;
      veredicto: 'hay_en_tienda' | 'sin_existencia' | 'no_medido';
    };

/**
 * `[FLT.23]` Cuántos minutos después de anotarlo se puede deshacer desde el mostrador.
 *
 * Cinco y no más: el botón existe para el arrepentimiento inmediato de quien vio la ventana
 * abierta, no para editar el historial de la semana. Pasada la ventana, la corrección es de
 * Compras (`decidir(..., 'era_error')`), que deja rastro de quién la tomó.
 */
export const VENTANA_DESHACER_MIN = 5;

export interface DeshacerResult {
  id: string;
  /** `true` = la fila entera se fue (el reporte deshecho era el único de la semana). */
  eliminado: boolean;
  /** Cuántos reportes quedan en la semana después de restar. */
  times_reported: number;
}

export interface ReportarResult {
  id: string;
  kind: StockoutKind;
  /** A quién le toca. Derivado de (kind, existencia) — ver `destinoDe`. */
  destino: StockoutDestino;
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
    /**
     * `[ZN.3]` El alcance de datos (ADR-050). `@Optional()` **no**: acá el alcance
     * decide si se contesta o no, y un servicio que se instancia sin él tendría
     * que elegir entre abrirse (fail-open) o romperse. Se exige en el módulo.
     */
    private readonly scope: ScopeService,
  ) {}

  /**
   * `[ZN.3]` — ¿Esta persona alcanza ESTA sucursal?
   *
   * ── El defecto que cierra ───────────────────────────────────────────────────
   * `GET /faltantes/sucursal/:code` aceptaba **cualquier** código en la ruta. El
   * permiso que la abre (`STORE_STOCKOUT_CAPTURAR`) lo tienen **30 personas con
   * alcance acotado** —cajeros, auxiliares de tienda, encargados, verificadores—,
   * así que quien trabaja en Padre Hidalgo podía pedir `/sucursal/05` y leer lo
   * reportado en Zamora. El gate del permiso decía «puede abrir la pantalla»; lo
   * que faltaba era **sobre qué filas**, que es el otro eje (ADR-050).
   *
   * ── Por qué 403 y no un recorte silencioso ─────────────────────────────────
   * Pidió una sucursal concreta. Devolverle la lista de OTRA (la suya) sería
   * contestar una pregunta distinta de la que hizo, y en una pantalla de
   * inventario eso se lee como «en Zamora no falta nada». Se le dice que no.
   *
   * Medido antes de encenderlo: las 17 personas con alcance acotado sobre
   * etiquetas/faltantes son todas `own` y **todas tienen `warehouse_code` en su
   * ficha**, así que el alcance resuelve — nadie se queda sin su propia sucursal.
   */
  private async assertAlcanza(warehouseCode: string): Promise<void> {
    // El corte vive en `ScopeService.assertCanRead` y no acá: lo necesitan cuatro
    // servicios y un primitivo copiado a mano se desincroniza (ADR-056).
    await this.scope.assertCanRead('warehouse', warehouseCode);
  }

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
  // CONSULTA — «¿lo tenemos?»
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `[FLT.22]` Lo que la pantalla contesta ANTES de pedir nada.
   *
   * ── Por qué existe, medido ──────────────────────────────────────────────────────────────────
   * La primera versión era un formulario: pedía capturar y contestaba "gracias". Todo el beneficio
   * caía en Compras, tres días después. **En cinco días la usó UNA persona de piso de 19 cajeras**
   * (9 reportes, y 3 eran de cuentas de prueba). Nadie hace captura para beneficio ajeno con un
   * cliente enfrente.
   *
   * Esto da vuelta el trato: primero le contesta a quien pregunta —*¿vale la pena que alguien
   * camine a la bodega?*— y el reporte queda como consecuencia de una consulta útil. Es la misma
   * pregunta que tienen la cajera y el anaquelista, y es la razón por la que van a abrirla.
   *
   * ── Lo que devuelve y lo que NO inventa ─────────────────────────────────────────────────────
   * `existencia` es la del ERP (`analytics.v_erp_stock_on_hand`, la vista que mide 100% contra el
   * POS). **`null` significa "no se pudo leer", nunca 0** — y los dos casos llevan etiquetas
   * distintas, porque "no hay" y "no sé" mandan a la persona a hacer cosas opuestas (ADR-056).
   */
  async consultar(warehouseCode: string, termino: string): Promise<ConsultaResultado> {
    if (!warehouseCode) throw new BadRequestException('Falta la sucursal');
    const q = (termino || '').trim();
    if (!q) throw new BadRequestException('Falta el código o la clave a consultar');
    await this.assertAlcanza(warehouseCode);

    return this.tk.run(async (trx) => {
      const wh = await trx('commercial.warehouses')
        .select('id', 'code', 'name')
        .whereRaw('LOWER(code) = LOWER(?)', [warehouseCode])
        .whereNull('deleted_at')
        .first();
      if (!wh) throw new NotFoundException(`No existe la sucursal ${warehouseCode}`);

      const producto = await this.resolverProducto(trx, q, q);
      if (!producto) {
        // El catálogo contestó que no existe. Es autoritativo y NO se disfraza de error.
        return {
          encontrado: false as const,
          termino: q,
          warehouse_code: wh.code,
          warehouse_name: wh.name ?? null,
        };
      }

      const [existencia, precio] = await Promise.all([
        this.leerExistencia(trx, wh.id, producto.id),
        this.leerPrecio(trx, wh.code, producto.sku),
      ]);

      return {
        encontrado: true as const,
        termino: q,
        warehouse_code: wh.code,
        warehouse_name: wh.name ?? null,
        sku: producto.sku,
        product_name: producto.name,
        precio,
        existencia,
        /**
         * El veredicto que la persona necesita, ya resuelto acá para que las dos pantallas no lo
         * calculen cada una a su manera. `no_medido` NO es `sin_existencia`: con el primero se
         * manda a alguien a buscar, con el segundo no.
         */
        veredicto: existencia == null
          ? ('no_medido' as const)
          : existencia > 0
            ? ('hay_en_tienda' as const)
            : ('sin_existencia' as const),
      };
    });
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
        destino: destinoDe(r.kind, onHandNum),
        times_reported: Number(r.times_reported),
        product_name: r.product_name ?? null,
        on_hand_at_report: onHandNum,
        est_lost_revenue: r.est_lost_revenue != null ? Number(r.est_lost_revenue) : null,
        est_source: r.est_source,
        // Dijo "no hay" y el ERP dice que sí, DESPUÉS de haberlo buscado. Eso ya es un descuadre
        // afirmado por una persona — antes esta bandera se encendía sola, por construcción.
        // Se DERIVA del destino y no se reimplementa: es la misma pregunta con otro nombre, y
        // escrita dos veces son dos respuestas el día que una de las dos cambie.
        contradice_al_erp: destinoDe(r.kind, onHandNum) === 'inventario',
      };
    });
  }

  /**
   * `[FLT.23]` — Deshacer lo que se acaba de anotar SOLO.
   *
   * ── Por qué hizo falta ───────────────────────────────────────────────────────────────────────
   * El verificador anota el faltante sin preguntar cuando la existencia es 0. Eso es deliberado
   * (son cinco segundos en un mostrador, no hay lugar para un formulario), pero crea un caso que
   * antes no existía: **el reporte se escribe sin que nadie lo haya decidido.** Una consulta de
   * precio que no venía de un cliente queda anotada igual.
   *
   * La salida tenía que ser del lado de la TIENDA. `decidir()` existe y archiva con `era_error`,
   * pero pide `COMPRAS_HALLAZGOS_GESTIONAR` — un permiso que la cajera no tiene, y que además
   * convierte un «me equivoqué hace tres segundos» en trabajo de la bandeja de Compras.
   *
   * ── Por qué decrementa y no archiva ─────────────────────────────────────────────────────────
   * El grano es (sucursal, motivo, cosa, SEMANA) con contador: la tercera consulta del mismo
   * producto no crea una fila, sube el `times_reported` de la que ya estaba. Archivar la fila
   * borraría también los dos reportes legítimos anteriores. Así que esto **resta uno**, y sólo
   * elimina la fila cuando el reporte que se deshace era el único que la sostenía.
   * `est_lost_revenue` se recalcula sobre el contador nuevo por la misma razón que al sumar: si se
   * dejara el valor viejo, restar un reporte no bajaría el dinero.
   *
   * ── Los tres frenos ─────────────────────────────────────────────────────────────────────────
   *  1. **Alcance** (`assertAlcanza`), igual que todo lo demás acá: el id es adivinable y el
   *     permiso lo tienen 30 personas repartidas en nueve plazas.
   *  2. **Sólo `open`.** Si Compras ya lo atendió, el reporte dejó de ser del mostrador.
   *  3. **Sólo lo RECIÉN anotado** (`VENTANA_DESHACER_MIN`). No se compara contra `reported_by`
   *     porque el kiosco corre sin cuenta de persona (`[CV.24]`) y el dueño de la fila puede ser
   *     NULL: con ese criterio nadie podría deshacer en el kiosco, que es justo donde más falta
   *     hace. La ventana de tiempo acota lo mismo sin romper ese caso.
   *
   * ⚠️ No es un borrado administrativo ni pretende serlo: un faltante viejo que no debió existir
   * se sigue resolviendo con `decidir(..., 'era_error')`, del lado de Compras.
   */
  async deshacer(id: string): Promise<DeshacerResult> {
    if (!id?.trim()) throw new BadRequestException('Falta el reporte a deshacer');

    return this.tk.run(async (trx) => {
      const fila = await trx('commercial.floor_stockouts as f')
        .join('commercial.warehouses as w', 'w.id', 'f.warehouse_id')
        .select(
          'f.id',
          'f.times_reported',
          'f.status',
          'f.unit_price',
          'w.code as warehouse_code',
          trx.raw(
            `(f.last_reported_at > now() - (? || ' minutes')::interval) AS dentro_de_ventana`,
            [VENTANA_DESHACER_MIN],
          ),
        )
        .where('f.id', id)
        .first();

      if (!fila) throw new NotFoundException('No existe ese reporte de faltante');

      await this.assertAlcanza(fila.warehouse_code);

      if (fila.status !== 'open') {
        throw new ConflictException(
          'Compras ya atendió este faltante: no se puede deshacer desde la tienda',
        );
      }
      if (!fila.dentro_de_ventana) {
        throw new ConflictException(
          `Sólo se puede deshacer lo que se acaba de anotar (${VENTANA_DESHACER_MIN} minutos). ` +
            'Pedile a Compras que lo marque como "no era faltante".',
        );
      }

      const veces = Number(fila.times_reported);

      // Era el único reporte que sostenía la fila: la fila se va con él.
      if (veces <= 1) {
        await trx('commercial.floor_stockouts').where({ id }).del();
        return { id, eliminado: true, times_reported: 0 };
      }

      const { rows } = await trx.raw(
        `UPDATE commercial.floor_stockouts
            SET times_reported   = times_reported - 1,
                est_lost_revenue = CASE WHEN unit_price IS NOT NULL
                                        THEN ROUND(unit_price * (times_reported - 1), 2)
                                        ELSE NULL END,
                updated_at       = now()
          WHERE id = ?
        RETURNING times_reported`,
        [id],
      );
      return { id, eliminado: false, times_reported: Number(rows[0].times_reported) };
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
    await this.assertAlcanza(warehouseCode);
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
    await this.assertAlcanza(warehouseCode);
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
            -- ⚠️ Esta condicion es la unica copia de destinoDe() que vive fuera de TypeScript:
            -- el SQL no puede llamarla. Es 'inventario' escrito en SQL. Si cambia la regla, este
            -- FILTER y el de abajo cambian con ella, o el KPI deja de cuadrar con la columna
            -- "Le toca a" de la misma pantalla.
            count(*) FILTER (WHERE status IN ('open','in_progress')
                               AND kind = 'agotado'
                               AND on_hand_at_report > 0)                     AS contradicen_al_erp,
            count(*) FILTER (WHERE status IN ('open','in_progress')
                               AND kind = 'no_en_anaquel')                    AS recuperable_hoy,
            COALESCE(sum(est_lost_revenue) FILTER (WHERE status IN ('open','in_progress')
                               AND kind = 'no_en_anaquel'), 0)                AS dinero_recuperable_hoy
           FROM commercial.floor_stockouts`,
      );
      const r = rows[0];
      return {
        abiertos: Number(r.abiertos),
        /** Cuántos de los abiertos NO se pudieron valorar. Se declara para no leer el total como completo. */
        abiertos_sin_valorar: Number(r.abiertos_sin_valorar),
        dinero_estimado: Number(r.dinero_estimado),
        no_en_catalogo: Number(r.no_en_catalogo),
        /** Dijeron "no hay" y el ERP dice que sí DESPUÉS de buscarlo: descuadre, no compra. */
        contradicen_al_erp: Number(r.contradicen_al_erp),
        recuperable_hoy: Number(r.recuperable_hoy),
        dinero_recuperable_hoy: Number(r.dinero_recuperable_hoy),
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
      destino: destinoDe(r.kind as StockoutKind, onHand),
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
      contradice_al_erp: destinoDe(r.kind as StockoutKind, onHand) === 'inventario',
    };
  }
}
