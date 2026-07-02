import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Dominio REPARTIDOR (última milla) — SEPARADO del vendedor.
 *
 * El repartidor NO vende ni toma pedidos: recibe paradas ya despachadas, entrega,
 * cobra y reporta incidencias. Por eso su lógica vive aquí y no en VendorService
 * (comparten el shell de la app por conveniencia, pero no la lógica de negocio).
 */

/** Parada a domicilio asignada al repartidor. */
export interface RiderDelivery {
  recipient_id: string;
  status: string;
  customer_name: string;
  delivery_address:
    | { street?: string; references?: string; recipient_name?: string; phone?: string; lat?: number; lng?: number }
    | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  incident_type?: string | null;
  shipment_folio?: string | null;
  shipment_id?: string | null;
  shipment_notes?: string | null;
  order_id?: string | null;
  order_code?: string | null;
  total?: number | string | null;
  balance_due?: number | string | null;
  payment_method?: string | null;
}

export type DeliveryOutcome =
  | 'delivered'
  | 'not_located'
  | 'wrong_address'
  | 'customer_rejected'
  | 'missing_product'
  | 'other';

/** Payload para cerrar una parada (entrega o incidencia). */
export interface RecordDeliveryOutcome {
  outcome: DeliveryOutcome;
  delivered_to?: string;
  signature_url?: string;
  proof_photo_url?: string;
  whatsapp_confirmed?: boolean;
  gps_lat?: number;
  gps_lng?: number;
  payment?: {
    order_id: string;
    method: 'cash' | 'transfer' | 'card' | 'prepaid';
    amount: number;
    cash_received?: number;
    reference?: string;
  };
  incident_notes?: string;
  attempted_at?: string;
}

@Injectable({ providedIn: 'root' })
export class RiderService {
  private readonly http = inject(HttpClient);
  private readonly apiRoot = environment.apiUrl;

  /** Paradas a domicilio asignadas al repartidor (logística resuelve por driver.user_id). */
  myDeliveries(): Observable<RiderDelivery[]> {
    return this.http.get<RiderDelivery[]>(`${this.apiRoot}/logistics/home-dispatch/my-deliveries`);
  }

  /** Cierra la parada: entrega (evidencia + cobro) o incidencia tipificada. */
  recordDeliveryOutcome(recipientId: string, dto: RecordDeliveryOutcome): Observable<any> {
    return this.http.post(
      `${this.apiRoot}/commercial/home-delivery/recipients/${recipientId}/outcome`,
      dto,
    );
  }
}
