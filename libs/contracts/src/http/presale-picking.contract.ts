/**
 * `[MCP.3]` + `[MCP.8]` Surtido de preventa por pedido y avance para la vendedora.
 *
 * El surtidor de la sucursal recibe en su bandeja los pedidos de preventa de SU almacén, separados
 * por día de entrega; registra quién empieza a surtir y a qué hora, marca lo que hubo por renglón y
 * cierra. Lo que no hubo se QUITA del pedido y el total se recalcula (decisión de David,
 * 2026-10-14); la vendedora recibe el reporte.
 *
 * La vendedora ve, por pedido: agendado → lo tomó el surtidor → surtido → cobrado en Kepler →
 * entregado. "Cobrado" puede venir de la liga confirmada (la hace una persona, D2/D6 de la Fase MCP)
 * o de una DETECCIÓN: un solo ticket del cliente, posterior al surtido, con los mismos productos.
 * La detección se muestra como tal; no escribe la liga.
 */

/** Pestañas de la bandeja. `hoy` incluye lo vencido: lo atrasado también se surte hoy. */
export type PresalePickBucket = 'hoy' | 'manana' | 'proximos';

/** Estado del surtido de un pedido. `en_recorrido` = ya va en una ola de la consola de surtido. */
export type PresalePickState = 'nuevo' | 'surtiendo' | 'completo' | 'con_faltantes' | 'en_recorrido';

export interface PresalePickPerson {
  user_id: string;
  name: string;
  /** ISO 8601. */
  at: string;
}

export interface PresalePickInboxRow {
  order_id: string;
  code: string;
  customer_name: string | null;
  seller_name: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  /** `YYYY-MM-DD`. */
  requested_delivery_date: string;
  bucket: PresalePickBucket;
  /** Días de atraso contra la fecha prometida (sólo en `hoy`; 0 = es de hoy). */
  days_late: number;
  /** ISO 8601: cuándo llegó a la sucursal (confirmación). Ordena dentro del día (D5: orden de llegada). */
  arrived_at: string;
  lines: number;
  total: number;
  state: PresalePickState;
  started: PresalePickPerson | null;
  finished: PresalePickPerson | null;
  /** Aviso de la sucursal sin acuse. */
  unseen: boolean;
  /**
   * `[MCP.3.13]` Pedido agrupado: folio del pedido PRINCIPAL del grupo (el del vendedor; si este
   * renglón es el principal, su propio folio). `null` = pedido suelto. Opcional por compatibilidad.
   */
  group_code?: string | null;
  /** Partes vivas del grupo (no canceladas), contando ésta. `null` = pedido suelto. */
  group_parts?: number | null;
  /** Etiqueta corta (`warehouses.short_label`, si no el nombre) de las sucursales de las OTRAS partes. `[]` = suelto. */
  group_other_warehouses?: string[];
}

export interface PresalePickInboxResponse {
  /** `YYYY-MM-DD` en hora de México. */
  today: string;
  counts: Record<PresalePickBucket, number>;
  data: PresalePickInboxRow[];
  /** `ninguno` = el usuario no tiene almacén en su alcance; se dice, no se muestra vacío mudo. */
  scope: 'todos' | 'propios' | 'ninguno';
}

export interface PresalePickLine {
  line_id: string;
  product_id: string;
  sku: string | null;
  /** `[MCP.3.1]` Código de barras del catálogo: el surtidor escanea la etiqueta para encontrar el renglón. */
  barcode?: string | null;
  product_name: string;
  /** Cantidad pedida en la unidad en que se capturó (`qty_unit`); si no hay sello, en unidad base. */
  qty: number;
  unit: string;
  /** Piezas de unidad base por unidad mostrada (1 si no hay sello). */
  factor: number;
  /** Lo que se marcó al surtir (en la unidad mostrada). `null` = el pedido no se ha cerrado. */
  picked: number | null;
}

export interface PresalePickDetail {
  order: PresalePickInboxRow;
  lines: PresalePickLine[];
}

export interface PresalePickFinishRequest {
  /** Una entrada por cada renglón del pedido: lo que sí hubo, en la unidad mostrada. */
  lines: Array<{ line_id: string; picked: number }>;
}

export interface PresalePickReportLine {
  product_name: string;
  unit: string;
  ordered: number;
  picked: number;
}

export interface PresalePickReport {
  /** Renglones que se quitaron del pedido (no hubo nada). */
  removed: PresalePickReportLine[];
  /** Renglones que se ajustaron a lo que hubo. */
  adjusted: PresalePickReportLine[];
  total_before: number;
  total_after: number;
}

export interface PresalePickFinishResponse {
  order_id: string;
  outcome: 'completo' | 'con_faltantes';
  report: PresalePickReport | null;
}

/** Cómo se sabe que Kepler cobró el pedido. */
export type PresaleChargeSource = 'liga' | 'detectado';

export interface PresaleSellerCharge {
  source: PresaleChargeSource;
  folio_digital: string;
  fecha: string | null;
  total: number | null;
  /** Productos del pedido que aparecen en el ticket / productos del pedido. */
  shared_products: number;
  order_products: number;
}

export interface PresaleSellerOrder {
  order_id: string;
  code: string;
  customer_name: string | null;
  requested_delivery_date: string;
  total: number;
  lines: number;
  status: string;
  /** ISO 8601. */
  scheduled_at: string | null;
  warehouse_name: string | null;
  started: PresalePickPerson | null;
  finished: (PresalePickPerson & { outcome: 'completo' | 'con_faltantes' }) | null;
  report: PresalePickReport | null;
  charge: PresaleSellerCharge | null;
  /** ISO 8601 de la entrega de conformidad, o `null`. */
  delivered_at: string | null;
  /** El reporte de surtido todavía no lo ha visto la vendedora. */
  report_unseen: boolean;
}

export interface PresaleSellerStatusResponse {
  today: string;
  data: PresaleSellerOrder[];
  unseen_reports: number;
}
