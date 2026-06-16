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
  total: number;
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

// ───── Sprint M.3 — Ventas históricas ERP Mega_Dulces (FDW) ─────

export interface HistoricalDailyRow {
  day: string;
  lines: number;
  units: number;
  revenue: number;
  cost: number;
  margin: number;
}

export interface HistoricalTopProductRow {
  producto_id: string;
  producto: string;
  categoria: string;
  subfamilia: string;
  units: number;
  revenue: number;
}

export interface HistoricalByZonaRow {
  zona: string;
  almacen: string;
  tickets: number;
  unique_customers: number;
  units: number;
  revenue: number;
}

export interface HistoricalRankingRow {
  posicion: number;
  articulo: string;
  nombre: string;
  total_cajas: number;
  total_piezas: number;
  total_piezas_totales: number;
  total_venta: number;
}

/**
 * Margen por categoría sobre ventas del período. cost_base × cantidad vs venta_diaria.
 */
export interface HistoricalMarginRow {
  category: string;
  category_id: string | null;
  products: number;
  lines: number;
  units: number;
  revenue: number;
  cost: number;
  margin: number;
  margin_pct: number | null;
}

/**
 * Productos en top-N del ERP con stock disponible 0 — oportunidad de venta perdida.
 */
export interface RankingOutOfStockRow {
  posicion: number;
  articulo: string;
  product_id: string | null;
  nombre: string;
  total_venta: number;
  total_piezas_totales: number;
  total_qty: number;
  total_reserved: number;
  available: number;
}

/** Motor de Inteligencia (Fase M) — conversión del feedback loop. */
export interface ConversionSummary {
  window_days: number;
  offers: number;
  converted: number;
  conversion_pct: number;
}

@Injectable({ providedIn: 'root' })
export class CommandCenterService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/analytics`;
  private readonly intelBase = `${environment.apiUrl}/commercial/intelligence`;

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

  lowStock(threshold = 100, limit = 50): Observable<LowStockResponse> {
    const params = new HttpParams().set('threshold', threshold).set('limit', limit);
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

  // ───── M.3 historical (ERP) ─────

  historicalDaily(opts: { from?: string; to?: string; zona?: string }): Observable<HistoricalDailyRow[]> {
    let params = new HttpParams();
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.zona) params = params.set('zona', opts.zona);
    return this.http.get<HistoricalDailyRow[]>(`${this.base}/historical/daily`, { params });
  }

  historicalTopProducts(opts: { from?: string; to?: string; zona?: string; limit?: number }): Observable<HistoricalTopProductRow[]> {
    let params = new HttpParams();
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.zona) params = params.set('zona', opts.zona);
    if (opts.limit) params = params.set('limit', opts.limit);
    return this.http.get<HistoricalTopProductRow[]>(`${this.base}/historical/top-products`, { params });
  }

  historicalByZona(from?: string, to?: string): Observable<HistoricalByZonaRow[]> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http.get<HistoricalByZonaRow[]>(`${this.base}/historical/by-zona`, { params });
  }

  /**
   * Top productos del ERP pre-calculado (Mega_Dulces.ranking_productos vía FDW).
   * NO acepta filtros — el ERP mantiene esta tabla con su propia ventana
   * temporal (usualmente all-time o trailing-12M). Más fiel a la realidad
   * que `top-products` (que solo cuenta ventas registradas como `ventas` legacy).
   */
  historicalRanking(limit = 100): Observable<HistoricalRankingRow[]> {
    const params = new HttpParams().set('limit', limit);
    return this.http.get<HistoricalRankingRow[]>(`${this.base}/historical/ranking`, { params });
  }

  rankingOutOfStock(limit = 10, topN = 200): Observable<RankingOutOfStockRow[]> {
    const params = new HttpParams().set('limit', limit).set('topN', topN);
    return this.http.get<RankingOutOfStockRow[]>(`${this.base}/ranking-out-of-stock`, { params });
  }

  historicalMarginByCategory(opts: { from?: string; to?: string; limit?: number } = {}): Observable<HistoricalMarginRow[]> {
    let params = new HttpParams();
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.limit) params = params.set('limit', opts.limit);
    return this.http.get<HistoricalMarginRow[]>(`${this.base}/historical/margin-by-category`, { params });
  }

  // ───── Motor de Inteligencia (Fase M) ─────

  /** Conversión del feedback loop (ofertas → pedidos en ventana). */
  conversionSummary(days = 30): Observable<ConversionSummary> {
    const params = new HttpParams().set('days', days);
    return this.http.get<ConversionSummary>(`${this.intelBase}/signals/summary`, { params });
  }

  /** Clientes due-for-reorder hoy (para el contador del Command Center). */
  nbaDue(limit = 100): Observable<Array<{ customer_id: string }>> {
    const params = new HttpParams().set('limit', limit);
    return this.http.get<Array<{ customer_id: string }>>(`${this.intelBase}/nba`, { params });
  }
}
