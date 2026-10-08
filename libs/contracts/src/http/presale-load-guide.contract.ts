/**
 * `[MCP.5]` La FORMA del wire de las guías de carga de preventa (Fase MCP, ADR-089).
 *
 * El repartidor (o el vendedor) PESCA en su celular los pedidos de preventa que se lleva; la cajera
 * imprime la GUÍA DE CARGA por ruta que él firma (D8). Una guía por (repartidor, sucursal, ruta, día)
 * (D12). La guía impresa queda congelada (snapshot) y es la base de la liquidación (MCP.7).
 *
 * Servicio en `libs/commercial/src/lib/presale-control/load-guide.service.ts`.
 */
import type { PresaleOrderRow } from './warehouse-presale.contract';

export type LoadGuideStatus = 'abierta' | 'impresa' | 'cancelada';

export interface LoadGuideOrderRow {
  order_id: string;
  code: string;
  customer_name: string | null;
  customer_erp_code: string | null;
  /** `YYYY-MM-DD`. */
  requested_delivery_date: string;
  total: number;
  /** Documento de Kepler ligado (si ya lo hay), con su total. */
  folio_digital: string | null;
  document_total: number | null;
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
  /** Las guías del día consultado, más las ABIERTAS de días anteriores (siguen esperando impresión). */
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
