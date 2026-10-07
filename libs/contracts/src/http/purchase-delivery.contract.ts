/**
 * `[RE.32]` Entrega de compras recibidas a Finanzas — `/commercial/purchase-deliveries`.
 *
 * El auxiliar de compras marca lo que tiene en físico y validado, genera una entrega con folio
 * (`ENT-YYYY-NNNNN`) con quién entrega y quién recibe, y el PDF de respaldo. Finanzas la confirma y
 * puede rechazar renglón por renglón; un renglón rechazado regresa a pendientes.
 *
 * Producer `PurchaseDeliveriesController` y consumer `/compras/obligaciones` importan de acá (ADR-052).
 */

/** Con qué fecha se filtra y ordena lo pendiente. */
export type DeliveryDateBasis = 'recepcion' | 'factura';

/** Estado de la evidencia en `/compras/entradas` — REFERENCIA, no bloquea (el check es del auxiliar). */
export type ReceiptEvidenceStatus = 'sin_evidencia' | 'recibido' | 'validado' | 'rechazado';

export type PurchaseDeliveryStatus = 'entregada' | 'recibida' | 'recibida_parcial' | 'cancelada';
export type PurchaseDeliveryLineStatus = 'entregado' | 'aceptado' | 'rechazado' | 'cancelado';

/** Llave de una orden de entrada de Kepler (X-A-20) o Wincaja. */
export interface ReceiptKey {
  sucursal: string;
  doc_prefix: string;
  folio: string;
}

/** Una compra recibida que todavía no se entrega a Finanzas. */
export interface PendingReceiptRow extends ReceiptKey {
  oc_folio: string | null;
  supplier_code: string | null;
  supplier_name: string | null;
  /** Fecha del documento en Kepler (`receipt_date` de la vista) = fecha de FACTURA. */
  invoice_date: string | null;
  /** Captura del vale de entrada en Kepler = llegada física. NULL en Wincaja (sin verificar). */
  reception_date: string | null;
  reception_source: 'vale' | 'aplicacion' | null;
  amount: number;
  kepler_due_date: string | null;
  evidence_status: ReceiptEvidenceStatus;
  /** Días de la recepción a hoy (o de la factura, si no hay recepción). */
  days_waiting: number | null;
  /** Veces que Finanzas rechazó esta entrada en entregas anteriores (vuelve a pendientes). */
  times_rejected: number;
  last_rejection_reason: string | null;
}

export interface PendingReceiptsResponse {
  date_basis: DeliveryDateBasis;
  from: string | null;
  to: string | null;
  rows: PendingReceiptRow[];
  /** Entradas de Wincaja sin fecha de recepción que quedan fuera al filtrar por recepción. */
  excluded_without_reception_date: number;
  /** Proveedores marcados como internos (traspasos) que no se entregan. */
  excluded_internal: number;
  /** false mientras falte alguna de las migraciones RE.31 / RE.32: se ve, pero no se puede entregar. */
  schema_ready: boolean;
}

/** Persona de Finanzas/Tesorería que puede recibir y confirmar una entrega. */
export interface DeliveryRecipient {
  username: string;
  name: string;
  position_code: string | null;
}

export interface CreatePurchaseDeliveryDto {
  recipient_username: string;
  date_basis: DeliveryDateBasis;
  period_from?: string | null;
  period_to?: string | null;
  items: ReceiptKey[];
  notes?: string | null;
}

export interface PurchaseDeliveryLine extends ReceiptKey {
  id: string;
  oc_folio: string | null;
  supplier_code: string | null;
  supplier_name: string | null;
  invoice_date: string | null;
  reception_date: string | null;
  reception_source: string | null;
  amount: number;
  kepler_due_date: string | null;
  evidence_status: string | null;
  status: PurchaseDeliveryLineStatus;
  rejection_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export interface PurchaseDeliverySummary {
  id: string;
  code: string;
  status: PurchaseDeliveryStatus;
  date_basis: DeliveryDateBasis;
  period_from: string | null;
  period_to: string | null;
  delivered_by: string;
  delivered_by_name: string | null;
  delivered_at: string;
  recipient_username: string;
  recipient_name: string | null;
  received_by: string | null;
  received_at: string | null;
  line_count: number;
  total_amount: number;
  notes: string | null;
}

export interface PurchaseDeliveryDetail extends PurchaseDeliverySummary {
  lines: PurchaseDeliveryLine[];
}
