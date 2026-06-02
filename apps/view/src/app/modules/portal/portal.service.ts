import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map, of, switchMap, tap } from 'rxjs';
import { environment } from '../../../environments/environment';

// ─────────── Tipos ───────────

export interface PriceRow {
  id: string;
  product_id: string;
  product_name: string;
  brand_id?: string | null;
  brand_name?: string | null;
  /** Null si el producto no tiene precio configurado para el price_list del customer (catálogo completo). */
  price: number | string | null;
  tax_rate: number | string | null;
  min_qty: number;
  /** J.6.7: si el endpoint se llamó con `?warehouse_id=X`, contiene stock real disponible (quantity - reserved). Null si no se pidió. */
  stock_available?: number | null;
}

export interface AiSuggestion {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  qty: number;
  unit_price: number;
  min_qty?: number;
  reason: string;
}

export interface AiSuggestResponse {
  assistant_message: string;
  suggestions: AiSuggestion[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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
  applied_promo_code?: string | null;
  applied_promo_type?: string | null;
  discount_amount?: number | string | null;
  notes?: string;
}

export interface Order {
  id: string;
  code: string;
  status: 'draft' | 'pending_approval' | 'confirmed' | 'fulfilled' | 'cancelled';
  customer_id: string;
  warehouse_id: string;
  subtotal: number | string;
  tax_total: number | string;
  total: number | string;
  balance_due: number | string;
  basket_promo_code?: string | null;
  basket_discount_amount?: number | string | null;
  notes?: string;
  created_at: string;
  pending_approval_at?: string;
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

  readonly cartLineCount = signal<number>(0);
  readonly cartTotal = signal<number>(0);
  readonly cartId = signal<string | null>(null);
  readonly cartDetail = signal<Order | null>(null);

  refreshCart(): void {
    this.getActiveDraft().subscribe({
      next: (d) => {
        if (!d) {
          this.cartLineCount.set(0);
          this.cartTotal.set(0);
          this.cartId.set(null);
          this.cartDetail.set(null);
          return;
        }
        this.cartId.set(d.id);
        // `/orders/my` (list endpoint) no popula `lines` — solo trae el header
        // del order. Para count/total reales, encadenamos `orderById` que sí
        // devuelve el order completo con lines. Mismo signal alimenta el badge
        // del nav, el FAB con total, y el drawer del catálogo.
        this.orderById(d.id).subscribe({
          next: (full) => {
            this.cartDetail.set(full);
            this.cartLineCount.set(Array.isArray(full.lines) ? full.lines.length : 0);
            this.cartTotal.set(Number(full.total) || 0);
          },
          error: () => {
            this.cartDetail.set(null);
            this.cartLineCount.set(0);
            this.cartTotal.set(Number(d.total) || 0);
          },
        });
      },
      error: () => {
        this.cartLineCount.set(0);
        this.cartTotal.set(0);
        this.cartId.set(null);
        this.cartDetail.set(null);
      },
    });
  }

  /**
   * Trae el draft con sus lines populadas. Acepta orderId opcional para
   * encadenar desde refreshCart() (donde cartId() aún no se ha seteado al
   * momento de la llamada).
   */
  refreshCartDetail(orderId?: string): void {
    const id = orderId || this.cartId();
    if (!id) {
      this.cartDetail.set(null);
      return;
    }
    this.orderById(id).subscribe({
      next: (full) => this.cartDetail.set(full),
      error: () => this.cartDetail.set(null),
    });
  }

  // ─── Catalog ───

  listPriceLists() {
    return this.http.get<any[]>(`${this.base}/price-lists`);
  }

  /**
   * Lista precios de una price list. Si `warehouseId` viene, el response incluye
   * `stock_available` por producto (J.6.7 — para mostrar badges en catalog).
   *
   * Sprint M: el endpoint pasa a estar paginado por default (100/page). Para
   * el portal/vendor pedimos `pageSize=5000` para traer la lista entera
   * (alineado con el uso histórico: mostrar el catálogo completo del customer).
   * Backend devuelve `{ data, pagination }` — extraemos `data`.
   */
  listPricesForList(priceListId: string, warehouseId?: string): Observable<PriceRow[]> {
    let params = new HttpParams().set('pageSize', 5000);
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<{ data: PriceRow[] } | PriceRow[]>(
      `${this.base}/price-lists/${priceListId}/prices`,
      { params },
    ).pipe(
      // Tolerar ambos shapes durante deploy en progreso (array legacy o
      // wrapped). Después del cutover de la API se puede simplificar.
      map((r: any) => Array.isArray(r) ? r : (r?.data || [])),
    );
  }

  /**
   * Lista COMPLETA del catálogo: todos los productos activos de public.products
   * (incluidos los que tienen embedding en pgvector). Precio del customer y
   * stock vienen como LEFT JOIN — `price` es `null` para productos sin precio
   * configurado para el price_list del customer.
   *
   * Usado por el portal-catalog para mostrar el catálogo completo en vez de
   * limitar a los productos con price_list (que devolvía `listPricesForList`).
   */
  listCatalogProducts(warehouseId?: string): Observable<PriceRow[]> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<PriceRow[]>(`${this.base}/catalog/products`, { params });
  }

  listWarehouses() {
    return this.http.get<any[]>(`${this.base}/warehouses`);
  }

  /**
   * Customer linkeado al JWT del user (users.customer_id). Bypass del listado
   * paginado que devolvía "el primero del tenant" — causaba drafts en customer
   * ≠ al customer del user → /orders/my nunca los veía y el carrito quedaba
   * vacío visualmente aunque DB tuviera lines. Backend resuelve por user_id
   * del CLS.
   */
  myCustomerInfo() {
    return this.http.get<any>(`${this.base}/customers/me`);
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
    return this.http
      .post<OrderLine>(`${this.base}/orders/${orderId}/lines`, {
        product_id: productId,
        quantity,
      })
      .pipe(tap(() => this.refreshCart()));
  }

  updateLine(orderId: string, lineId: string, quantity: number): Observable<OrderLine> {
    return this.http
      .patch<OrderLine>(`${this.base}/orders/${orderId}/lines/${lineId}`, { quantity })
      .pipe(tap(() => this.refreshCart()));
  }

  removeLine(orderId: string, lineId: string) {
    return this.http
      .delete<{ deleted: boolean }>(`${this.base}/orders/${orderId}/lines/${lineId}`)
      .pipe(tap(() => this.refreshCart()));
  }

  confirm(orderId: string): Observable<Order> {
    return this.http
      .post<Order>(`${this.base}/orders/${orderId}/confirm`, {})
      .pipe(tap(() => this.refreshCart()));
  }

  cancel(orderId: string, reason?: string) {
    return this.http
      .post<Order>(`${this.base}/orders/${orderId}/cancel`, { reason })
      .pipe(tap(() => this.refreshCart()));
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

  // ─── Promociones activas (home dashboard) ───

  listActivePromotions(pageSize = 6): Observable<PromotionRow[]> {
    let p = new HttpParams().set('onlyActive', 'true').set('pageSize', String(pageSize));
    return this.http
      .get<{ data: PromotionRow[] }>(`${this.base}/promotions`, { params: p })
      .pipe(map((r) => r.data || []));
  }

  // ─── AI Order builder (Claude Haiku chat) ───

  aiOrderSuggest(message: string, history: ChatMessage[] = []): Observable<AiSuggestResponse> {
    return this.http.post<AiSuggestResponse>(`${this.base}/ai-order/suggest`, {
      message,
      history,
    });
  }

  // ─── Búsqueda semántica del catálogo (Voyage + pgvector) ───

  smartSearch(query: string, limit = 24): Observable<SmartSearchResponse> {
    return this.http.post<SmartSearchResponse>(`${this.base}/catalog/search`, {
      query,
      limit,
    });
  }
}

export interface SmartSearchResult {
  product_id: string;
  product_name: string;
  brand_id: string | null;
  brand_name: string | null;
  price: number;
  tax_rate: number;
  min_qty: number;
  stock_available: number | null;
  score: number;
}

export interface SmartSearchResponse {
  results: SmartSearchResult[];
  mode: 'semantic' | 'fallback_like';
}

export interface PromotionRow {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  promotion_type: string;
  starts_at?: string | null;
  ends_at?: string | null;
  active: boolean;
  priority: number;
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
