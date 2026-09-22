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

/** Condiciones de un cliente de mayoreo EN UNA SUCURSAL. Difieren entre sucursales. */
export interface WholesaleBranchTerms {
  sucursal: string;
  credit_limit: number | string | null;
  payment_days: number | null;
  discount_1_pct: number | string | null;
  discount_2_pct: number | string | null;
  zone_code: string | null;
  group_code: string | null;
}

export interface WholesaleCustomer {
  customer_code: string;
  name: string;
  phone: string | null;
  rfc: string | null;
  address_1: string | null;
  state: string | null;
  branches: WholesaleBranchTerms[];
  /** true = sus condiciones NO son iguales en todas las sucursales. La pantalla lo dice. */
  terms_vary_by_branch: boolean;
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

  /**
   * Padrón de MAYOREO (`C####`) derivado de `kepler_ods.kdud`.
   * Cada cliente trae el arreglo de sus sucursales porque sus condiciones difieren entre ellas.
   */
  searchWholesaleCustomers(search: string, limit = 20): Observable<WholesaleCustomer[]> {
    let params = new HttpParams().set('limit', String(limit));
    if (search) params = params.set('search', search);
    return this.http.get<WholesaleCustomer[]>(`${this.base}/wholesale-customers`, { params });
  }

  create(payload: {
    customer_id?: string;
    erp_customer_code?: string;
    source_branch?: string;
    contact_name?: string;
    contact_phone?: string;
    contact_email?: string;
    origin?: QuoteOrigin;
    /** Opcional desde [E.12.1]: en mayoreo el ancla es `source_branch`, no la ruta. */
    warehouse_id?: string;
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
