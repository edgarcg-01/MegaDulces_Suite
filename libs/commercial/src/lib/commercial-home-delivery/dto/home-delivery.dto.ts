// Fase LM.2/LM.4 — DTOs de intake y entrega a domicilio. Validación en el servicio.

import type { DeliveryAddress, DeliveryChannel } from '../../commercial-orders/commercial-orders.service';
import type { PaymentMethod } from '../../commercial-payments/dto/payment.dto';

/**
 * Cobro capturado por el repartidor en la parada. Sin order_id: el backend lo
 * ata a lo que referencie la parada (commercial.orders O folio Kepler).
 */
export interface OutcomePaymentDto {
  method: PaymentMethod;
  amount: number;
  cash_received?: number;
  reference?: string;
}

export interface IntakeLineDto {
  product_id: string;
  quantity: number;
}

/** Alta rápida de cliente casual (sin cartera formal). */
export interface CasualCustomerDto {
  name: string;
  phone: string;
}

/**
 * Intake de un pedido a domicilio. O bien `customer_id` (cliente de cartera)
 * o bien `casual` (alta rápida). `warehouse_id` opcional → default del tenant.
 */
export interface HomeDeliveryIntakeDto {
  customer_id?: string;
  casual?: CasualCustomerDto;
  warehouse_id?: string;
  delivery_address: DeliveryAddress;
  delivery_channel: DeliveryChannel;
  promised_eta_min?: number;
  notes?: string;
  lines: IntakeLineDto[];
}

/** Resultado de la parada: entregado o una incidencia tipificada (§10 SOP). */
export type DeliveryOutcome =
  | 'delivered'
  | 'not_located'
  | 'wrong_address'
  | 'customer_rejected'
  | 'missing_product'
  | 'other';

export const DELIVERY_OUTCOMES: DeliveryOutcome[] = [
  'delivered',
  'not_located',
  'wrong_address',
  'customer_rejected',
  'missing_product',
  'other',
];

/** El repartidor cierra la parada: entrega (con evidencia + cobro) o incidencia. */
export interface RecordDeliveryOutcomeDto {
  outcome: DeliveryOutcome;
  // ── delivered ──
  delivered_to?: string;
  /** Firma del cliente (canvas → URL). Evidencia POD obligatoria (o foto/WhatsApp). */
  signature_url?: string;
  proof_photo_url?: string;
  whatsapp_confirmed?: boolean;
  gps_lat?: number;
  gps_lng?: number;
  /** Cobro en la entrega (omitir si prepago). */
  payment?: OutcomePaymentDto;
  // ── incidencia ──
  incident_notes?: string;
  attempted_at?: string; // ISO
}
