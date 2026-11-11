/**
 * `[MCP.10]` Revisión en caja de un pedido de preventa ya surtido.
 *
 * Antes de cobrar, la cajera revisa el pedido producto por producto contra lo que le entregó el
 * surtidor. Lo normal es «Está bien». Si faltó algo y Kepler dice que hay, se lo pide al surtidor y
 * confirma «Ya se completó»; si no, «No hay». Si vino de más, lo devuelve. Al cerrar, el pedido de la
 * Suite queda con lo que de verdad se va a cobrar (se repone lo completado, se quita lo que no hubo).
 *
 * Por ahora sólo la ruta vecinal (decisión de David, 2026-10-29): son los pedidos de preventa que
 * ya surte la bandeja del surtidor (`/almacen/surtir-preventa`).
 */
import type { StockState } from './stock-state.contract';
import type { PresalePickPerson } from './presale-picking.contract';
import type { OrderJustification } from './order-justification.contract';

/**
 * `por_revisar` = surtido y sin revisar (desde cualquier día: no caduca); `revisado` = la caja ya lo
 * cerró. Lo surtido antes de que existiera la revisión (`review_required = false`) no aparece.
 */
export type PresaleReviewState = 'por_revisar' | 'revisado';

export interface PresaleReviewInboxRow {
  order_id: string;
  code: string;
  customer_name: string | null;
  seller_name: string | null;
  warehouse_name: string | null;
  /** `YYYY-MM-DD`. */
  requested_delivery_date: string;
  lines: number;
  total: number;
  /** Quién lo surtió y cuándo terminó. */
  finished: PresalePickPerson;
  /** Cómo lo cerró el surtidor. */
  pick_outcome: 'completo' | 'con_faltantes';
  state: PresaleReviewState;
  reviewed: PresalePickPerson | null;
  /** `[MCP.3.13]` Folio del pedido principal si es parte de un pedido agrupado; `null` = suelto. */
  group_code: string | null;
  /** `[MCP.3.15]` Indicaciones del vendedor; `null` = sin indicaciones. */
  instructions: string | null;
}

export interface PresaleReviewInboxResponse {
  /** `YYYY-MM-DD` en hora de México. */
  today: string;
  /**
   * Cuántos faltan por revisar (lo que la caja tiene que hacer), contados SIN el tope de filas. Lo no
   * revisado no tiene límite de días: se queda hasta que alguien lo revise.
   */
  pending: number;
  /** `true` = hay más por revisar de los que trae `data` (se llegó al tope); la pantalla lo dice. */
  truncated: boolean;
  data: PresaleReviewInboxRow[];
  /** `ninguno` = el usuario no tiene sucursal en su alcance; se dice, no se muestra vacío mudo. */
  scope: 'todos' | 'propios' | 'ninguno';
}

/** La existencia de Kepler del producto en la sucursal del pedido, en la unidad mostrada. */
export interface PresaleReviewStock {
  state: StockState;
  /** En la unidad mostrada (cajas, paquetes…), redondeado hacia abajo. `null` = sin dato. */
  qty: number | null;
  /** ISO de la última lectura de la sucursal; `null` = nunca se leyó. */
  checked_at: string | null;
}

export interface PresaleReviewLine {
  /** `line_id` del renglón; `borrado:<n>` si el surtido lo quitó del pedido. */
  key: string;
  product_id: string | null;
  product_name: string;
  /** `[VTK.15]` SKU del producto, siempre a la vista. `null` = no se conoce (renglón borrado sin copia). Opcional por compatibilidad. */
  sku?: string | null;
  /** Unidad mostrada (la de captura) y piezas base por unidad. */
  unit: string;
  factor: number;
  /** Lo que pidió el vendedor, en la unidad mostrada. */
  ordered: number;
  /** Lo que dejó el surtidor (lo que hoy dice el pedido). */
  picked: number;
  /**
   * ¿Se puede subir hasta lo pedido desde la caja? `false` = un renglón que el surtido borró antes
   * del 2026-10-29 (su reporte no guardó la copia): sólo se puede confirmar «No hay».
   */
  restorable: boolean;
  /** `null` = no se pudo leer la existencia (se declara, no se dibuja como cero). */
  stock: PresaleReviewStock | null;
  /** `[MCP.13]` El surtidor puso este producto EN LUGAR de otro que no hubo: el nombre del original. */
  substitutes_for?: string | null;
  /**
   * `[MCP.10.3]` Los códigos de barras con que se puede escanear, de la ficha de Kepler de la sucursal
   * (`kepler_ods.kdii`). Ausente = no se pudieron leer (se DECLARA: la caja toca en la lista); `[]` = el
   * producto no tiene código en esa sucursal.
   */
  codes?: PresaleReviewCode[];
}

/** `[MCP.10.3]` Un código del producto y cuántas piezas base trae lo escaneado (`null` = Kepler no tiene ese factor capturado). */
export interface PresaleReviewCode {
  code: string;
  factor: number | null;
}

/** `[MCP.10.3]` Cómo coincidió lo buscado, de la más segura a la menos: código exacto, SKU, código sin ceros a la izquierda, nombre. */
export type PresaleReviewMatch = 'codigo' | 'sku' | 'codigo_sin_ceros' | 'nombre';

/** `[MCP.10.3]` Un producto de un pedido por revisar que coincide con lo buscado. */
export interface PresaleReviewSearchHit {
  order_id: string;
  code: string;
  customer_name: string | null;
  seller_name: string | null;
  product_name: string;
  sku: string | null;
  match: PresaleReviewMatch;
}

/** `GET warehouse/presale-review/search?q=` — ¿en qué pedido por revisar está este producto? */
export interface PresaleReviewSearchResponse {
  q: string;
  data: PresaleReviewSearchHit[];
  /** Hay más de lo que se devuelve (coincidencias o pedidos por revisar fuera del tope): se DECLARA. */
  truncated: boolean;
}

/** Rango de cada forma de coincidir: cuando varias aplican, sólo cuenta la más segura. */
export const RANGO_COINCIDENCIA: Readonly<Record<PresaleReviewMatch, number>> = { codigo: 3, sku: 2, codigo_sin_ceros: 1, nombre: 0 };

const codigoLimpio = (s: string | null | undefined): string => String(s ?? '').trim().toUpperCase();
const sinCeros = (s: string): string => s.replace(/^0+(?=.)/, '');

/**
 * `[MCP.10.3]` ¿Lo buscado es un código o el SKU de este producto? La comparten la pantalla de Revisión y
 * la búsqueda en los otros pedidos, para que «coincide» signifique lo mismo en los dos lados.
 *
 * El código EXACTO manda: en Kepler `006001` (pieza) y `06001` (paquete) son distintos. Sin ceros a la
 * izquierda sólo vale si no hubo exacto y entonces NO dice qué unidad es (`factor: null`): señala el
 * producto, nunca confirma solo. El SKU tampoco dice unidad.
 */
export function coincidenciaDeCodigo(
  q: string, codes: readonly PresaleReviewCode[], sku: string | null | undefined,
): { match: Exclude<PresaleReviewMatch, 'nombre'>; factor: number | null } | null {
  const c = codigoLimpio(q);
  if (!c) return null;
  const exacto = codes.find((x) => codigoLimpio(x.code) === c);
  if (exacto) return { match: 'codigo', factor: exacto.factor };
  if (sku && codigoLimpio(sku) === c) return { match: 'sku', factor: null };
  const c0 = sinCeros(c);
  if (codes.some((x) => sinCeros(codigoLimpio(x.code)) === c0)) return { match: 'codigo_sin_ceros', factor: null };
  if (sku && sinCeros(codigoLimpio(sku)) === c0) return { match: 'sku', factor: null };
  return null;
}

export interface PresaleReviewDetail {
  order: PresaleReviewInboxRow;
  lines: PresaleReviewLine[];
  /** `[MCP.18]` Por qué cambió el pedido antes de llegar a caja (vendedora, surtidor). Ausente = servidor anterior. */
  justifications?: OrderJustification[];
}

export interface PresaleReviewFinishRequest {
  /**
   * Una entrada por cada renglón de la revisión. `final` = lo que se queda en el pedido y se cobra
   * (0..lo pedido, en la unidad mostrada). `returned` = lo que vino de más y se devolvió al surtidor.
   * `[MCP.18]` `reason` (clave de `MOTIVOS_CAJA`) y `reason_note`: por qué la caja deja MENOS de lo que
   * surtió el surtidor. En cualquier otro renglón se ignora; ausente = sin motivo registrado.
   */
  lines: Array<{ key: string; final: number; returned?: number; reason?: string | null; reason_note?: string | null }>;
}

/** Cómo se resolvió un renglón en caja. */
export type PresaleReviewResolution = 'bien' | 'completo' | 'no_hubo' | 'devuelto';

export interface PresaleReviewResultLine {
  key: string;
  product_name: string;
  unit: string;
  ordered: number;
  picked: number;
  final: number;
  returned: number;
  resolution: PresaleReviewResolution;
  /** `[MV.1]` SKU del producto; ausente en revisiones anteriores al monitoreo vecinal. */
  sku?: string | null;
  /** `[MCP.18]` Por qué la caja dejó menos de lo surtido: clave de `MOTIVOS_CAJA`. Ausente = sin motivo registrado. */
  reason?: string;
  /** `[MCP.18]` Nota del motivo (obligatoria con «Otro motivo»). */
  reason_note?: string;
}

/** Lo que se guarda en `presale_picks.review`. */
export interface PresaleReviewResult {
  lines: PresaleReviewResultLine[];
  total_before: number;
  total_after: number;
}

export interface PresaleReviewFinishResponse {
  order_id: string;
  review: PresaleReviewResult;
}
