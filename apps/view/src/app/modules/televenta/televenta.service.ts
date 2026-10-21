import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface QueueItem {
  customer_id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  reason: 'inactive_critical' | 'callback_due' | 'inactive_normal' | 'never_ordered' | 'general';
  last_order_at: string | null;
  last_call_at: string | null;
  callback_due_at: string | null;
  days_since_last_order: number | null;
  total_orders: number;
}

export interface ReservationRecord {
  id: string;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  reserved_at: string;
  expires_at: string;
  expires_in_seconds: number;
}

export interface CustomerSnapshot {
  customer: {
    id: string; code: string; name: string;
    phone: string | null; email: string | null; notes: string | null;
    credit_limit: number | null; balance: number | null; payment_terms_days: number | null;
  };
  recent_orders: Array<{
    id: string; code: string; status: string; total: number;
    created_at: string; confirmed_at: string | null;
  }>;
  recent_calls: Array<{
    id: string; called_at: string; outcome: string;
    notes: string | null; next_action_at: string | null;
    operator_username: string | null;
  }>;
  reservation: ReservationRecord | null;
}

export type CallOutcome =
  | 'sale' | 'no_sale' | 'callback_scheduled'
  | 'no_answer' | 'wrong_contact' | 'other';

export interface LogCallPayload {
  customer_id: string;
  outcome: CallOutcome;
  notes?: string;
  duration_minutes?: number;
  next_action_at?: string;
  order_id?: string;
  release_reservation?: boolean;
}

/**
 * Fase E — wrapper HTTP de `/api/commercial/televenta/*`.
 */
@Injectable({ providedIn: 'root' })
export class TeleventaService {
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  getQueue(limit = 50): Observable<QueueItem[]> {
    return this.http.get<QueueItem[]>(
      `${this.apiUrl}/commercial/televenta/queue?limit=${limit}`,
    );
  }

  getMyReservations(): Observable<ReservationRecord[]> {
    return this.http.get<ReservationRecord[]>(
      `${this.apiUrl}/commercial/televenta/my-reservations`,
    );
  }

  reserveLead(customerId: string): Observable<ReservationRecord> {
    return this.http.post<ReservationRecord>(
      `${this.apiUrl}/commercial/televenta/leads/${customerId}/reserve`,
      {},
    );
  }

  releaseReservation(reservationId: string): Observable<{ released: boolean }> {
    return this.http.post<{ released: boolean }>(
      `${this.apiUrl}/commercial/televenta/reservations/${reservationId}/release`,
      {},
    );
  }

  getCustomerSnapshot(customerId: string): Observable<CustomerSnapshot> {
    return this.http.get<CustomerSnapshot>(
      `${this.apiUrl}/commercial/televenta/customers/${customerId}/snapshot`,
    );
  }

  getCustomerCalls(customerId: string, limit = 20): Observable<CustomerSnapshot['recent_calls']> {
    return this.http.get<CustomerSnapshot['recent_calls']>(
      `${this.apiUrl}/commercial/televenta/customers/${customerId}/calls?limit=${limit}`,
    );
  }

  logCall(payload: LogCallPayload): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(
      `${this.apiUrl}/commercial/televenta/calls`,
      payload,
    );
  }

  /** E.4 — Dashboard métricas */
  getDashboard(): Observable<TeleventaDashboard> {
    return this.http.get<TeleventaDashboard>(
      `${this.apiUrl}/commercial/televenta/dashboard`,
    );
  }
}

export interface TeleventaDashboard {
  period: { from: string; to: string };
  today: {
    calls: number;
    orders_taken: number;
    no_answer: number;
    callbacks: number;
    not_interested: number;
    total_minutes: number;
  };
  my_stats: {
    my_calls: number;
    my_orders: number;
    my_minutes: number;
  } | null;
  active_reservations: { total: number; unique_operators: number };
  conversion_7d: { total_calls: number; orders_taken: number; conversion_pct: number };
  top_operators: Array<{ user_id: string; username: string | null; calls: number; orders: number; minutes: number }>;
  outcomes_7d: Array<{ outcome: string; count: number }>;
  /** Los primeros 5 de `GET /queue`, en su mismo orden (no una consulta aparte). */
  queue_preview: Array<{ id: string; code: string; name: string; phone: string | null; last_order_at: string | null }>;
  /**
   * E.9 — la facturación REAL del canal, del ERP (`U/D/8`, canal TELEMARK).
   * Es independiente de la captura de llamadas: existe aunque nadie registre una llamada aquí.
   */
  billing: TelemarketingBilling;
  /** `registrada:false` ⇒ nadie ha capturado llamadas: los ceros de arriba son ausencia, no desempeño. */
  actividad: { registrada: boolean; nota: string };
}

export interface TelemarketingDescuentos {
  /** Facturas CON renglones: el universo de la cascada. */
  facturas: number;
  /** La réplica trae la cabecera antes que el detalle: éstas quedan fuera de la cuenta. */
  facturas_sin_renglones: number;
  total_sin_renglones: number;
  renglones: number;
  /** Sin precio de lista en el ERP: ahí el descuento de producto es un piso. */
  renglones_sin_lista: number;
  lista: number;
  producto: number;
  subtotal: number;
  cliente: number;
  facturado: number;
  /** Contra el maestro de clientes de HOY: salieron con menos % del negociado. */
  negociado_no_aplicado: { facturas: number; monto: number };
  /** Contra el maestro de HOY: salieron con más % del que el maestro registra. */
  sin_respaldo_maestro: { facturas: number; monto: number };
}

export interface TelemarketingBilling {
  hoy: { facturas: number; importe: number };
  mes: { facturas: number; importe: number };
  d30: {
    facturas: number; importe: number; clientes: number;
    saldo: number; saldo_vencido: number; facturas_vencidas: number;
  };
  /** Vencido de TODA la cartera del canal, sin ventana de emisión (la deuda vieja incluida). */
  cartera_vencida: { saldo: number; facturas: number };
  /** De los `d30.clientes` facturados, cuántos existen en el padrón de la cola. */
  clientes_en_cola: number;
  /** Fecha de NEGOCIO del documento más reciente (no el reloj del navegador). */
  ultima_factura: string | null;
  /** El operador viene del ERP (`vendedor_code`): no hay con qué cruzarlo a un usuario. */
  por_operador: Array<{
    vendedor_code: string | null; vendedor_nombre: string | null;
    facturas: number; importe: string; saldo: string; clientes: number;
    /** `[E.15]` null = el operador no tiene renglones todavía: no se sabe, no es $0. */
    descuento_producto: number | null; descuento_cliente: number | null; importe_lista: number | null;
  }>;
  /** `[E.15]` La cascada del descuento en 30 días: lista − producto = subtotal − cliente = facturado. */
  descuentos: TelemarketingDescuentos;
  ultimas: Array<{
    folio_digital: string; sucursal: string; doc_prefix: string; folio: string; fecha: string;
    cliente_code: string; cliente_nombre: string; vendedor_nombre: string | null;
    total: string; saldo: string | null;
    estatus_cobro: 'pagada' | 'parcial' | 'pendiente' | 'sin_cartera' | 'cancelada';
    vencida: boolean;
  }>;
  atribucion: 'erp_vendedor_code';
}
