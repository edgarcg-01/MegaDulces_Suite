// Fase LM.1 — DTOs de cobros. Validación en el servicio (estilo del dominio).

export type PaymentMethod = 'cash' | 'transfer' | 'card' | 'prepaid';
export const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'transfer', 'card', 'prepaid'];

export type PaymentStatus = 'received' | 'verified' | 'reversed';

/** Registrar un cobro contra un pedido. */
export interface RecordPaymentDto {
  order_id: string;
  method: PaymentMethod;
  /** Monto aplicado al pedido (lo que abona al balance). > 0. */
  amount: number;
  /** Solo cash: efectivo que entregó el cliente (para calcular el cambio). */
  cash_received?: number;
  /** Folio de transferencia | nº autorización/voucher de tarjeta. */
  reference?: string;
  /** Comprobante de transferencia | foto del voucher de tarjeta (URL). */
  proof_url?: string;
  notes?: string;
}

/** Entregar + cobrar en una sola transacción (repartidor en la parada). */
export interface DeliverAndCollectDto {
  /** Pago a registrar. Omitir si el pedido es prepago (no se cobra en la entrega). */
  payment?: RecordPaymentDto;
}

/**
 * Cobro COD ligado a un FOLIO de Kepler (Fase LM-K), sin commercial.orders.
 * Entra al mismo ledger que el arqueo del repartidor (received_by).
 */
export interface RecordKeplerPaymentDto {
  kepler_folio: string;
  kepler_serie?: string;
  kepler_warehouse_code?: string;
  method: PaymentMethod;
  amount: number;
  cash_received?: number;
  reference?: string;
  notes?: string;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  customer_id: string;
  amount: number;
  payment_method: PaymentMethod;
  status: PaymentStatus;
  reference: string | null;
  cash_received: number | null;
  change_given: number | null;
  proof_url: string | null;
  received_by: string;
  received_at: string;
  notes: string | null;
}
