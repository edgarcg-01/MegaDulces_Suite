import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[E.12]` — Cotizaciones de mayoreo (submódulo de Telemarketing).
 *
 * Wrapper del backend `commercial/quotes`. No guarda estado: los componentes son dueños de su
 * señal. Mismo criterio que `TeleventaService`.
 */

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
export type QuoteOrigin = 'telemarketing' | 'route_visit' | 'counter' | 'portal';

export interface QuoteListRow {
  id: string;
  code: string;
  status: QuoteStatus;
  origin: QuoteOrigin;
  customer_id: string | null;
  customer_code: string | null;
  recipient_name: string;
  quote_date: string;
  valid_until: string;
  days_to_expiry: number;
  total: number;
  currency: string;
  line_count: number;
  unmatched_count: number;
  order_id: string | null;
  order_code: string | null;
  created_at: string;
  user_id: string;
  created_by_username: string | null;
}

export interface QuotesSummary {
  by_status: Record<QuoteStatus, number>;
  open_amount: number;
  open_count: number;
  expiring_soon_count: number;
  overdue_count: number;
}

export interface QuotesPage {
  rows: QuoteListRow[];
  total: number;
}

@Injectable({ providedIn: 'root' })
export class QuotesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/quotes`;

  list(opts: {
    status?: string;
    origin?: string;
    mine?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Observable<QuotesPage> {
    let params = new HttpParams();
    if (opts.status) params = params.set('status', opts.status);
    if (opts.origin) params = params.set('origin', opts.origin);
    if (opts.mine) params = params.set('mine', 'true');
    if (opts.search) params = params.set('search', opts.search);
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<QuotesPage>(this.base, { params });
  }

  summary(mine = false): Observable<QuotesSummary> {
    let params = new HttpParams();
    if (mine) params = params.set('mine', 'true');
    return this.http.get<QuotesSummary>(`${this.base}/summary`, { params });
  }

  getOne(id: string): Observable<Record<string, unknown>> {
    return this.http.get<Record<string, unknown>>(`${this.base}/${id}`);
  }

  create(payload: {
    customer_id?: string;
    contact_name?: string;
    contact_phone?: string;
    contact_email?: string;
    origin?: QuoteOrigin;
    warehouse_id: string;
    price_list_id?: string;
    valid_until?: string;
    customer_request?: string;
    notes?: string;
  }): Observable<{ id: string; code: string; status: QuoteStatus; valid_until: string }> {
    return this.http.post<{ id: string; code: string; status: QuoteStatus; valid_until: string }>(
      this.base,
      payload,
    );
  }

  cancel(id: string, reason: string): Observable<{ id: string; code: string; status: QuoteStatus }> {
    return this.http.post<{ id: string; code: string; status: QuoteStatus }>(
      `${this.base}/${id}/cancel`,
      { reason },
    );
  }
}
