import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map, of, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';

// ─────────── Tipos ───────────

export interface PriceRow {
  id: string;
  product_id: string;
  product_name: string;
  price: number | string;
  tax_rate: number | string;
  min_qty: number;
  /** J.6.7: si el endpoint se llamó con `?warehouse_id=X`, contiene stock real disponible (quantity - reserved). Null si no se pidió. */
  stock_available?: number | null;
}

export interface OrderLine {
  id: string;
  order_id: string;
  product_id: string;
  line_number: number;
  quantity: number | string;
  unit_price: number | string;
  tax_rate: number | string;
  discount_percent: number | string;
  line_subtotal: number | string;
  line_tax: number | string;
  line_total: number | string;
  notes?: string;
}

export interface Order {
  id: string;
  code: string;
  status: 'draft' | 'confirmed' | 'fulfilled' | 'cancelled';
  customer_id: string;
  warehouse_id: string;
  subtotal: number | string;
  tax_total: number | string;
  total: number | string;
  balance_due: number | string;
  notes?: string;
  created_at: string;
  confirmed_at?: string;
  fulfilled_at?: string;
  cancelled_at?: string;
  lines?: OrderLine[];
}

export interface OrderHistoryEntry {
  id: string;
  from_status: string | null;
  to_status: string;
  changed_by: string | null;
  changed_by_username: string | null;
  reason: string | null;
  changed_at: string;
}

@Injectable({ providedIn: 'root' })
export class PortalService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl + '/commercial';

  // ─── Catalog ───

  listPriceLists() {
    return this.http.get<any[]>(`${this.base}/price-lists`);
  }

  /**
   * Lista precios de una price list. Si `warehouseId` viene, el response incluye
   * `stock_available` por producto (J.6.7 — para mostrar badges en catalog).
   */
  listPricesForList(priceListId: string, warehouseId?: string): Observable<PriceRow[]> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<PriceRow[]>(
      `${this.base}/price-lists/${priceListId}/prices`,
      { params },
    );
  }

  listWarehouses() {
    return this.http.get<any[]>(`${this.base}/warehouses`);
  }

  myCustomerInfo() {
    return this.http.get<{ data: any[] }>(`${this.base}/customers?pageSize=1`).pipe(
      map((r) => r.data?.[0] || null),
    );
  }

  // ─── Cart (= draft order) ───

  /**
   * Resuelve el draft activo del customer del JWT, o devuelve null si no hay.
   */
  getActiveDraft(): Observable<Order | null> {
    return this.http
      .get<{ data: Order[] }>(`${this.base}/orders/my?status=draft&pageSize=5`)
      .pipe(map((r) => (r.data?.[0] || null) as Order | null));
  }

  /**
   * Garantiza un draft creado para el customer. Si no hay draft activo, crea
   * uno con el warehouse default. Si ya hay, lo devuelve.
   */
  ensureDraft(customerId: string, warehouseId: string): Observable<Order> {
    return this.getActiveDraft().pipe(
      switchMap((existing) => {
        if (existing) return of(existing);
        return this.http.post<Order>(`${this.base}/orders`, {
          customer_id: customerId,
          warehouse_id: warehouseId,
        });
      }),
    );
  }

  addLine(orderId: string, productId: string, quantity: number): Observable<OrderLine> {
    return this.http.post<OrderLine>(`${this.base}/orders/${orderId}/lines`, {
      product_id: productId,
      quantity,
    });
  }

  updateLine(orderId: string, lineId: string, quantity: number): Observable<OrderLine> {
    return this.http.patch<OrderLine>(`${this.base}/orders/${orderId}/lines/${lineId}`, {
      quantity,
    });
  }

  removeLine(orderId: string, lineId: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/orders/${orderId}/lines/${lineId}`);
  }

  confirm(orderId: string): Observable<Order> {
    return this.http.post<Order>(`${this.base}/orders/${orderId}/confirm`, {});
  }

  cancel(orderId: string, reason?: string) {
    return this.http.post<Order>(`${this.base}/orders/${orderId}/cancel`, { reason });
  }

  // ─── My orders ───

  myOrders(opts: { status?: string; page?: number; pageSize?: number } = {}) {
    let p = new HttpParams();
    if (opts.status) p = p.set('status', opts.status);
    if (opts.page) p = p.set('page', String(opts.page));
    if (opts.pageSize) p = p.set('pageSize', String(opts.pageSize));
    return this.http.get<{ data: Order[]; page: number; pageSize: number; total: number }>(
      `${this.base}/orders/my`,
      { params: p },
    );
  }

  orderById(id: string): Observable<Order> {
    return this.http.get<Order>(`${this.base}/orders/${id}`);
  }

  orderHistory(id: string): Observable<OrderHistoryEntry[]> {
    return this.http.get<OrderHistoryEntry[]>(`${this.base}/orders/${id}/history`);
  }

  // ─── Recommendations (D.4) ───

  myRecommendations(): Observable<RecommendedBasketDto> {
    return this.http.get<RecommendedBasketDto>(`${this.base}/recommendations/my`);
  }
}

export type RecommendationCategory = 'base' | 'focus' | 'exploration' | 'innovation';

export interface RecommendationItem {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  category: RecommendationCategory;
  score: number;
  reason: string;
  sample_price: number;
  units_in_last_period?: number;
}

export interface RecommendedBasketDto {
  customer_id: string;
  computed_at: string;
  total_recommendations: number;
  category_counts: Record<RecommendationCategory, number>;
  items: RecommendationItem[];
}
