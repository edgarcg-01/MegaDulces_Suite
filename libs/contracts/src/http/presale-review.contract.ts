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
}

export interface PresaleReviewDetail {
  order: PresaleReviewInboxRow;
  lines: PresaleReviewLine[];
}

export interface PresaleReviewFinishRequest {
  /**
   * Una entrada por cada renglón de la revisión. `final` = lo que se queda en el pedido y se cobra
   * (0..lo pedido, en la unidad mostrada). `returned` = lo que vino de más y se devolvió al surtidor.
   */
  lines: Array<{ key: string; final: number; returned?: number }>;
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
