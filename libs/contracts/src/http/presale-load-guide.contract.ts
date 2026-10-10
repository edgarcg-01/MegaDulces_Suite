/**
 * `[MCP.5]` La FORMA del wire de las guías de carga de preventa (Fase MCP, ADR-089).
 *
 * El repartidor (o el vendedor) PESCA en su celular los pedidos de preventa que se lleva; la cajera
 * imprime la GUÍA DE CARGA por ruta que él firma (D8). Una guía por (repartidor, sucursal, ruta, día)
 * (D12). La guía impresa queda congelada (snapshot) y es la base de la liquidación (MCP.7).
 *
 * Servicio en `libs/commercial/src/lib/presale-control/load-guide.service.ts`.
 */
import type { PresaleCandidate, PresaleOrderRow } from './warehouse-presale.contract';

/** `[MCP.7]` `liquidada` = ya se cuadró en caja contra lo que trajo quien entregó. */
export type LoadGuideStatus = 'abierta' | 'impresa' | 'liquidada' | 'cancelada';

export interface LoadGuideOrderRow {
  order_id: string;
  code: string;
  customer_name: string | null;
  customer_erp_code: string | null;
  /** `YYYY-MM-DD`. */
  requested_delivery_date: string;
  total: number;
  /** Documento de Kepler: el que se entregó, o el ligado si todavía no se entrega. Con su total. */
  folio_digital: string | null;
  document_total: number | null;
  /**
   * `[MCP.6]` `cargado` = va en camino; `entregado` = se registró la conformidad;
   * `no_entregado` (lo dijo el celular) y `regreso` (lo registró la caja) = volvió sin entregarse:
   * siguen en la guía porque están en el papel firmado, pero no suman al total.
   */
  status: 'cargado' | 'entregado' | 'no_entregado' | 'regreso';
  /** `[MCP.6]` Lo que cobró quien entregó (null mientras no se entrega). */
  cash_amount: number | null;
  transfer_amount: number | null;
  transfer_ref: string | null;
  delivery_outcome: 'completo' | 'con_diferencia' | null;
  /** `[MCP.7]` Qué fue diferente, cuando se entregó con diferencia. */
  delivery_note: string | null;
  /** `[MCP.6]` Por qué volvió sin entregarse (`no_entregado` / `regreso`). */
  removed_reason: string | null;
  /**
   * `[MCP.7]` El pedido se canceló después de cargarlo. Si la guía ya se imprimió, la caja registra su
   * regreso; no suma al total ni se entrega.
   */
  order_cancelled: boolean;
}

/** `[MCP.6]` Lo que ve el celular al abrir un pedido para entregarlo. */
export interface PresaleFieldOrderDetail {
  order: PresaleOrderRow;
  guide: { id: string; folio: string; status: 'abierta' | 'impresa' };
  /** Renglones del pedido (lo que se lleva). */
  lines: Array<{ sku: string | null; description: string | null; quantity: number; unit: string | null }>;
  /** Documentos de Kepler del cliente, el más parecido al pedido primero. Vacío si hay `link_block`. */
  candidates: PresaleCandidate[];
}

export interface PresaleDeliverRequest {
  order_id: string;
  /** Documento de Kepler que se entrega (uno de los candidatos, o el ya ligado). */
  folio_digital: string;
  outcome: 'completo' | 'con_diferencia';
  /** Obligatoria si `con_diferencia`. */
  note?: string;
  cash_amount: number;
  transfer_amount: number;
  /** Obligatoria si hay transferencia. */
  transfer_ref?: string;
}

export interface PresaleNotDeliveredRequest {
  order_id: string;
  reason: string;
}

export interface LoadGuide {
  id: string;
  folio: string;
  status: LoadGuideStatus;
  rider_user_id: string;
  rider_name: string | null;
  branch: string;
  branch_name: string | null;
  sales_route: string;
  /** `YYYY-MM-DD`. */
  business_date: string;
  printed_at: string | null;
  printed_by_name: string | null;
  print_count: number;
  orders: LoadGuideOrderRow[];
  /** Σ de los pedidos que lleva (total del pedido). La liquidación (MCP.7) se hace contra los documentos. */
  total: number;
  /** `[MCP.7]` La liquidación que la cerró, o `null` si aún no se liquida. */
  liquidation: { id: string; folio: string } | null;
}

/** Lo que ve el repartidor o el vendedor en su celular. */
export interface PresaleFieldResponse {
  /** Pedidos que puede pescar (confirmados, sin guía). */
  available: PresaleOrderRow[];
  /** Sus guías ABIERTAS (de cualquier día: siguen esperando impresión) y las impresas de hoy. */
  mine: LoadGuide[];
  /**
   * De dónde salen los pedidos:
   *  · `sucursal` — repartidor: los de las sucursales de su alcance (el rol `repartidor` tiene todas).
   *  · `propios`  — vendedor: los que él levantó (13 de 19 vendedores no tienen sucursal en su ficha).
   */
  source: 'sucursal' | 'propios';
  /** `YYYY-MM-DD` en hora de México. */
  today: string;
}

export interface LoadGuidesResponse {
  /**
   * Las guías del día consultado, más las de días anteriores que siguen pendientes: ABIERTAS (esperan
   * impresión) e IMPRESAS (esperan liquidación, MCP.7).
   */
  data: LoadGuide[];
  /** `YYYY-MM-DD` consultado. */
  date: string;
  /** `todos` = sin recorte; `recortado` = sólo sus sucursales; `ninguno` = su ficha no tiene sucursal. */
  scope: 'todos' | 'recortado' | 'ninguno';
}

/** `[MCP.5]` La caja registra que un pedido de una guía ya impresa regresó sin entregarse. */
export interface PresaleReturnRequest {
  order_id: string;
  reason: string;
}

export interface PresaleLoadRequest {
  order_ids: string[];
}

export interface PresaleUnloadRequest {
  order_id: string;
}

/** `[MCP.7]` Lo que la caja revisa antes de contar: las guías de un regreso y lo que se espera. */
export interface LoadGuideLiquidationPreview {
  rider_user_id: string;
  rider_name: string | null;
  branch: string;
  guides: LoadGuide[];
  /** Σ documentos de Kepler entregados (los que el ODS conoce). */
  documents_total: number;
  /** Entregados cuyo documento no trae total en el ODS: se declaran aparte. */
  documents_without_total: number;
  delivered: number;
  not_delivered: number;
  /** Pedidos que siguen en camino: con alguno, NO se puede liquidar (se registra su regreso antes). */
  pending: number;
  /** Lo que quien entregó declaró al entregar. */
  declared_cash: number;
  declared_transfer: number;
  /** Cada transferencia con su referencia, para revisarla. */
  transfers: Array<{ order_code: string; customer_name: string | null; folio_digital: string | null; amount: number; ref: string | null }>;
  /** Por qué no se puede liquidar, o `null` si se puede. */
  /** Documentos entregados − lo declarado (efectivo + transferencia), donde el documento trae total. */
  pending_collection: number;
  /**
   * La parte de `pending_collection` que nadie explicó (pedidos entregados "completo" cuyo cobro no
   * cuadra con el documento). Si no es 0, la liquidación exige nota.
   */
  unexplained_difference: number;
  blocked_reason: string | null;
}

export interface PresaleLiquidationPreviewRequest {
  guide_ids: string[];
}

export interface PresaleLiquidateRequest {
  guide_ids: string[];
  /** Arqueo por denominación (llaves del catálogo de `money/denominations`) → cantidad de piezas. */
  cash_breakdown: Record<string, number>;
  /** Obligatoria si lo contado no cuadra con lo declarado. */
  notes?: string;
  /**
   * Lo declarado que la caja VIO en la vista previa. Si cambió (alguien registró una entrega
   * mientras se contaba), el servidor responde 409 para que la caja revise antes de firmar.
   */
  expected_declared_cash: number;
  expected_declared_transfer: number;
}

export interface LoadGuideLiquidation {
  id: string;
  folio: string;
  rider_user_id: string;
  rider_name: string | null;
  branch: string;
  /** `YYYY-MM-DD`. */
  business_date: string;
  guide_folios: string[];
  documents_total: number;
  declared_cash: number;
  declared_transfer: number;
  counted_cash: number;
  /** contado − declarado: negativo = faltante, positivo = sobrante. */
  cash_difference: number;
  /** Lo que Kepler cobró y no se declaró en pedidos "completo" (explicado en la nota). */
  unexplained_difference: number;
  notes: string | null;
  /** ISO. */
  liquidated_at: string;
  liquidated_by_name: string | null;
  print_count: number;
}

export interface LoadGuideLiquidationsResponse {
  data: LoadGuideLiquidation[];
  /** `YYYY-MM-DD` consultado. */
  date: string;
}
