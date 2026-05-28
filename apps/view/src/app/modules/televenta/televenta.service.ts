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
  queue_preview: Array<{ id: string; code: string; name: string; phone: string | null; last_order_at: string | null }>;
}
