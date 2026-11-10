/**
 * `[PQ.94]` Compras › Temporadas — el contrato entre la API (`/compras/temporadas`) y la pantalla.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_PEDIDO_VERDAD_Y_CIERRE.md` §19.8–§19.11. Las tablas viven en
 * `catalog.seasons` · `catalog.season_dates` · `catalog.season_products` (migración 20261110010537).
 *
 * ⛔ Una sola puerta de escritura (§19.8): sólo estos endpoints escriben la temporada de un producto.
 * ⛔ ADR-056: lo PROPUESTO (fechas o productos) no frena ni etiqueta nada; sólo lo confirmado.
 *
 * Sólo tipos y funciones puras: no pega al bundle.
 */

export type EstadoFechasTemporada = 'propuesta' | 'confirmada';
/** Dónde está HOY cada temporada-año respecto de su ventana de venta (hora de México). */
export type MomentoTemporada = 'por_iniciar' | 'en_venta' | 'terminada';
export type DecisionTemporada = 'confirmada' | 'descartada';
/** Si el producto vuelve cada año a esa temporada, o fue de un solo año. */
export type RecurrenciaTemporada = 'anual' | 'solo_un_anio';
/** `compra_unica`: no se repone (lo que sobra es remate). `hasta_corte`: se repone hasta la fecha de corte. */
export type ReposicionTemporada = 'compra_unica' | 'hasta_corte';
export type OrigenDecisionTemporada = 'propuesta_del_sistema' | 'manual';

export interface FechasTemporada {
  readonly id: string;
  readonly year: number;
  /** `YYYY-MM-DD`. Ventana de VENTA DEL MAYORISTA (va adelantada a la del consumidor, §19.11). */
  readonly sale_from: string;
  readonly sale_to: string;
  /** `null` = nadie la definió (no se inventa). */
  readonly buy_by: string | null;
  readonly cutoff: string | null;
  readonly clearance_from: string | null;
  readonly status: EstadoFechasTemporada;
  /** De dónde salió la propuesta (para que nadie la tome por dato). */
  readonly proposal_source: string | null;
  readonly confirmed_by_name: string | null;
  readonly confirmed_at: string | null;
  readonly momento: MomentoTemporada;
}

export interface TemporadaResumen {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly date_rule: 'fija' | 'movil';
  /** Del año más reciente al más viejo. */
  readonly fechas: readonly FechasTemporada[];
  /** Decisiones vigentes de las áreas (no cuenta candidatos: eso es por temporada-año). */
  readonly productos: { readonly confirmados: number; readonly descartados: number };
}

export interface TemporadasVista {
  /** `YYYY-MM-DD`, hoy en México: contra esto se calcula `momento`. */
  readonly hoy: string;
  /** Ordenadas: la que está en venta, después las por iniciar (la más cercana primero), al final las terminadas. */
  readonly temporadas: readonly TemporadaResumen[];
}

export interface CandidatoTemporada {
  readonly sku: string;
  readonly nombre: string;
  /** Pesos netos, sell-out canónico (Wincaja + Kepler), meses de la ventana. */
  readonly venta_temporada: number;
  readonly venta_12m: number;
  /** 0..1: qué parte de su venta de 12 meses cayó en la ventana. */
  readonly concentracion: number;
  readonly venta_mes_siguiente: number;
  /** `null` = el mes siguiente no ha cerrado: no se puede decir si se desplomó. */
  readonly cayo_despues: boolean | null;
  readonly por_nombre: boolean;
  readonly decision: DecisionTemporada | null;
  readonly decidido_at: string | null;
}

/** Una decisión vigente de la temporada que NO salió en la propuesta de este año (manual u otro año). */
export interface DecisionFueraDePropuesta {
  readonly sku: string;
  readonly nombre: string | null;
  readonly decision: DecisionTemporada;
  readonly origin: OrigenDecisionTemporada;
}

export interface CandidatosTemporada {
  readonly season_date_id: string;
  readonly season_id: string;
  readonly temporada: string;
  readonly year: number;
  readonly sale_from: string;
  readonly sale_to: string;
  readonly fechas_status: EstadoFechasTemporada;
  /** Meses que contaron como ventana (`fn_season_window_months`): un mes entra si la ventana cubre la mitad de sus días. */
  readonly meses: { readonly desde: string; readonly hasta: string };
  /** `false` = la ventana o su mes siguiente no han cerrado: la propuesta todavía puede cambiar y «cayó después» sale sin medir. */
  readonly ventana_cerrada: boolean;
  /**
   * Con cuántos meses de venta se calculó el «% de su año» (12 = completo). Menos de 12 pasa en las temporadas de
   * 2025: antes de 2025 no hay historia, así que el porcentaje sale INFLADO y la pantalla lo tiene que decir.
   */
  readonly base: { readonly meses: number; readonly completa: boolean };
  /** Cuándo se calculó (la API lo guarda: una temporada pasada no cambia). */
  readonly calculado_at: string;
  readonly candidatos: readonly CandidatoTemporada[];
  readonly fuera_de_propuesta: readonly DecisionFueraDePropuesta[];
  readonly resumen: {
    readonly propuestos: number;
    readonly confirmados: number;
    readonly descartados: number;
    readonly por_decidir: number;
  };
}

export interface DecisionProductoTemporadaDto {
  readonly sku: string;
  readonly decision: DecisionTemporada;
  readonly recurrence?: RecurrenciaTemporada | null;
  readonly only_year?: number | null;
  readonly replenishment?: ReposicionTemporada | null;
  readonly reason?: string | null;
  readonly origin: OrigenDecisionTemporada;
  /** Lo que vio el patrón al decidir (venta, concentración, desplome, año). Se guarda tal cual. */
  readonly evidence?: Record<string, unknown> | null;
}

export interface DecisionesTemporadaDto {
  readonly decisiones: readonly DecisionProductoTemporadaDto[];
}

/** Un lote nunca se reporta como «todo falló» por uno: dice cuántos entraron y cuáles no, con su motivo. */
export interface DecisionesTemporadaRespuesta {
  readonly guardadas: number;
  readonly fallidas: ReadonlyArray<{ readonly sku: string; readonly motivo: string }>;
}

export interface ConfirmarFechasTemporadaDto {
  readonly sale_from: string;
  readonly sale_to: string;
  readonly buy_by?: string | null;
  readonly cutoff?: string | null;
  readonly clearance_from?: string | null;
}

export interface ConfirmarFechasTemporadaRespuesta {
  readonly id: string;
  readonly status: 'confirmada';
}

/** Tope de un lote: más que el mayor universo medido (Navidad 2025, 140 propuestas). */
export const TEMPORADAS_LOTE_MAX = 300;

const FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `YYYY-MM-DD` que EXISTE: `2026-02-30` no pasa (V8 lo acepta en `Date.parse`; Postgres lo rechaza con 22008). */
const esFecha = (v: unknown): v is string => {
  const m = typeof v === 'string' ? FECHA.exec(v) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const f = new Date(Date.UTC(y, mo - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === mo - 1 && f.getUTCDate() === d;
};

/**
 * La misma regla que los CHECK de `catalog.season_products`, para decirla ANTES de enviar y en la API.
 * Devuelve el motivo en llano, o `null` si la decisión es válida.
 */
export function validarDecisionTemporada(d: Partial<DecisionProductoTemporadaDto> | null | undefined): string | null {
  const sku = typeof d?.sku === 'string' ? d.sku : '';
  if (!sku || sku !== sku.trim() || sku.length > 20) return 'La clave del producto no es válida.';
  if (d?.origin !== 'propuesta_del_sistema' && d?.origin !== 'manual') return 'Falta decir si el producto vino de la propuesta o se agregó a mano.';
  if (d?.decision === 'descartada') {
    if (!String(d.reason ?? '').trim()) return 'Para descartar hay que decir por qué (así la propuesta no vuelve sin explicación).';
    return null;
  }
  if (d?.decision !== 'confirmada') return 'La decisión es confirmar o descartar.';
  if (d.recurrence !== 'anual' && d.recurrence !== 'solo_un_anio') return 'Falta decir si el producto vuelve cada año o fue de un solo año.';
  if (d.recurrence === 'solo_un_anio' && !(Number.isInteger(d.only_year) && Number(d.only_year) >= 2020 && Number(d.only_year) <= 2100)) {
    return 'Si fue de un solo año, falta decir de cuál.';
  }
  if (d.recurrence === 'anual' && d.only_year != null) return 'Un producto anual no lleva año.';
  if (d.replenishment !== 'compra_unica' && d.replenishment !== 'hasta_corte') return 'Falta decir si es compra única o se repone hasta el corte.';
  return null;
}

/**
 * La misma regla que los CHECK de `catalog.season_dates`. Motivo en llano, o `null`. Con `year`, además, la venta
 * tiene que EMPEZAR en ese año (la temporada-año se nombra por el año en que empieza su venta: Reyes 2026 empieza
 * el 26-dic-2026 y termina en enero de 2027).
 */
export function validarFechasTemporada(f: Partial<ConfirmarFechasTemporadaDto> | null | undefined, year?: number): string | null {
  if (!esFecha(f?.sale_from) || !esFecha(f?.sale_to)) return 'Faltan las fechas de venta (desde y hasta).';
  if (year != null && Number(f.sale_from.slice(0, 4)) !== year) return `La venta de la temporada ${year} tiene que empezar en ${year}.`;
  if (f.sale_to < f.sale_from) return 'La venta no puede terminar antes de empezar.';
  if (f.buy_by != null && (!esFecha(f.buy_by) || f.buy_by > f.sale_from)) return 'La compra tiene que ser antes de que empiece la venta.';
  if (f.cutoff != null && (!esFecha(f.cutoff) || f.cutoff < f.sale_from || f.cutoff > f.sale_to)) return 'El corte de reposición tiene que caer dentro de la venta.';
  if (f.clearance_from != null && (!esFecha(f.clearance_from) || f.clearance_from <= f.sale_to)) return 'El remate empieza después de que termina la venta.';
  return null;
}
