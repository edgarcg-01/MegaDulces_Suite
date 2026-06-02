import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface OverviewResponse {
  source: 'mv' | 'live';
  refreshed_at: string | null;
  period: any;
  revenue: { gross: number; net: number; tax: number; currency: string };
  orders: {
    fulfilled: number;
    confirmed: number;
    draft: number;
    cancelled: number;
    avg_order_value: number;
  };
  units_sold?: number;
  unique_customers: number;
}

export interface TopCustomerRow {
  source: 'mv' | 'live';
  customer_id: string;
  code: string;
  name: string;
  orders_count: number;
  revenue: number;
  avg_order_value: number;
  last_order_at: string;
  rank?: number;
}

export interface TopProductRow {
  source: 'mv' | 'live';
  product_id: string;
  product_name: string;
  brand_name: string;
  units_sold: number;
  revenue: number;
  orders_count: number;
  rank_by_units?: number;
  rank_by_revenue?: number;
}

export interface SalesByBrandRow {
  brand_id: string;
  brand_name: string;
  units: number;
  revenue: number;
  share_pct: number;
}

export interface LowStockResponse {
  threshold: number;
  warehouse_id: string | null;
  items: Array<{
    warehouse_code: string;
    warehouse_name: string;
    product_name: string;
    brand_name: string;
    quantity: number;
    reserved_quantity: number;
    available_quantity: number;
  }>;
}

export interface InactiveCustomersResponse {
  threshold_days: number;
  customers: Array<{
    customer_id: string;
    code: string;
    name: string;
    phone: string | null;
    credit_limit: number;
    last_order_at: string | null;
    days_since_last_order: number | null;
  }>;
}

export interface RefreshResponse {
  refreshed_at: string;
  results: Array<{ mv: string; ok: boolean; ms?: number; error?: string }>;
}

export interface DailySeriesRow {
  day: string;
  orders_count: number;
  revenue: number;
  net_revenue: number;
}

@Injectable({ providedIn: 'root' })
export class CommandCenterService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/analytics`;

  overview(): Observable<OverviewResponse> {
    return this.http.get<OverviewResponse>(`${this.base}/overview`);
  }

  topCustomers(limit = 5): Observable<TopCustomerRow[]> {
    const params = new HttpParams().set('limit', limit);
    return this.http.get<TopCustomerRow[]>(`${this.base}/top-customers`, { params });
  }

  topProducts(limit = 5, orderBy: 'units' | 'revenue' = 'revenue'): Observable<TopProductRow[]> {
    const params = new HttpParams().set('limit', limit).set('orderBy', orderBy);
    return this.http.get<TopProductRow[]>(`${this.base}/top-products`, { params });
  }

  salesByBrand(): Observable<SalesByBrandRow[]> {
    return this.http.get<SalesByBrandRow[]>(`${this.base}/sales-by-brand`);
  }

  lowStock(threshold = 100): Observable<LowStockResponse> {
    const params = new HttpParams().set('threshold', threshold);
    return this.http.get<LowStockResponse>(`${this.base}/low-stock`, { params });
  }

  inactiveCustomers(days = 30, limit = 10): Observable<InactiveCustomersResponse> {
    const params = new HttpParams().set('days', days).set('limit', limit);
    return this.http.get<InactiveCustomersResponse>(`${this.base}/inactive-customers`, { params });
  }

  refresh(): Observable<RefreshResponse> {
    return this.http.post<RefreshResponse>(`${this.base}/refresh`, {});
  }

  dailySeries(from?: string, to?: string): Observable<DailySeriesRow[]> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http.get<DailySeriesRow[]>(`${this.base}/daily-series`, { params });
  }
}
