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
  /** Sus guías de hoy (abiertas e impresas). */
  mine: LoadGuide[];
  /**
   * De dónde salen los pedidos:
   *  · `sucursal` — repartidor: los de las sucursales de su alcance.
   *  · `propios`  — vendedor: los que él levantó (13 de 19 vendedores no tienen sucursal en su ficha).
   */
  source: 'sucursal' | 'propios';
  /** `YYYY-MM-DD` en hora de México. */
  today: string;
}

export interface LoadGuidesResponse {
  data: LoadGuide[];
  /** `YYYY-MM-DD` consultado. */
  date: string;
}

export interface PresaleLoadRequest {
  order_ids: string[];
}

export interface PresaleUnloadRequest {
  order_id: string;
}
