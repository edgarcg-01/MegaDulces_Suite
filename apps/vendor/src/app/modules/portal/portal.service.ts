import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, forkJoin, map, of, switchMap, tap } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

// ─────────── Tipos ───────────

export interface PriceRow {
  id: string;
  product_id: string;
  product_name: string;
  sku?: string | null;
  brand_id?: string | null;
  brand_name?: string | null;
  /** Null si el producto no tiene precio configurado para el price_list del customer (catálogo completo). */
  price: number | string | null;
  tax_rate: number | string | null;
  min_qty: number;
  /** J.6.7: si el endpoint se llamó con `?warehouse_id=X`, contiene stock real disponible (quantity - reserved). Null si no se pidió. */
  stock_available?: number | null;
  /** Sprint imágenes: URL pública Cloudinary. Null hasta que el importer la rellene. */
  image_url?: string | null;
  /** Top sellers MV: ranking 1..1000 según ERP Mega_Dulces.ranking_productos. */
  sales_rank?: number;
  /** Top sellers MV: unidades vendidas (histórico ERP). */
  units_sold?: number | string;
  /** Top sellers MV: revenue total (histórico ERP). */
  revenue?: number | string;
  /** Top sellers MV: cajas vendidas. */
  cases_sold?: number | string;
  /** Top sellers MV: piezas totales (incluye cajas × factor). */
  units_total?: number | string;
  /** Costo c/IVA unitario (ERP productos_activos.costo_civa). Solo en take-order — NULL para customer_b2b (anti-leak). */
  cost_with_tax?: number | string | null;
  /** Costo por caja (ERP productos_activos.costo_x_caja). Solo take-order. */
  cost_per_case?: number | string | null;
  /** Unidades vendidas últimos 30d (ERP). Driver del chip de rotación. */
  sales_units_30d?: number | null;
  /** Rotación: 'alta' | 'media' | 'baja' (derivada en el sync ERP). */
  rotation_tier?: 'alta' | 'media' | 'baja' | null;
}

/**
 * PriceRow + metadata del historial del customer (chip "Reordenar").
 * Permite que el grid del catálogo muestre "compraste 3× — última vez hace 2 sem"
 * sin requests adicionales.
 */
export interface CatalogHistoryRow extends PriceRow {
  times_ordered: number;
  last_ordered_at: string | null;
  total_quantity: number;
}

/**
 * PriceRow + metadata de la canasta IA (D.4) — chip "Sugeridos IA".
 * Cada producto trae su categoría heurística (base/focus/exploration/innovation)
 * + score 0..1 + reason humano-legible.
 */
export interface CatalogSuggestedRow extends PriceRow {
  rec_category: 'base' | 'focus' | 'exploration' | 'innovation' | null;
  rec_score: number;
  rec_reason: string;
}

/**
 * PriceRow + metadata de la promoción activa que aplica al producto.
 * Driver del chip "Con promo" del portal-catalog. Una sola promo por producto
 * (la de mayor `priority` del backend).
 */
export interface CatalogWithPromoRow extends PriceRow {
  promo_code: string;
  promo_name: string;
  promo_type: string;
}

/**
 * Facets agregados del catálogo. Driver del panel de filtros del portal —
 * counts pre-calculados en backend para chips con números reales.
 */
export interface CatalogFacets {
  total: number;
  brands: Array<{ brand_id: string | null; brand_name: string | null; count: number }>;
  price_buckets: Array<{ label: string; min: number; max: number | null; count: number }>;
  stock: { with_stock: number; without_stock: number } | null;
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
  /** Backend (orderById) hace join con products/brands — disponibles al leer el pedido. */
  product_name?: string | null;
  brand_name?: string | null;
  stock_available?: number | null;
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

export interface OrderShipmentEntry {
  id: string;
  folio: string;
  status:
    | 'programado'
    | 'checklist_salida'
    | 'en_ruta'
    | 'entregado'
    | 'checklist_llegada'
    | 'costos_pendientes'
    | 'cerrado'
    | 'cancelado';
  type: 'entrega' | 'traspaso' | 'recoleccion';
  origin: string | null;
  destination: string | null;
  shipment_date: string;
  departure_at: string | null;
  arrival_at: string | null;
  closed_at: string | null;
  created_at: string;
  vehicle_plate: string | null;
  route_name: string | null;
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
  listPricesForList(
    priceListId: string,
    warehouseId?: string,
    opts: { pricedOnly?: boolean } = {},
  ): Observable<PriceRow[]> {
    // priced_only: trae SOLO los productos pedibles (con precio) del price list,
    // completos en un fetch (sube el techo del backend a 10k). Sin él, el backend
    // capa a 500 → el catálogo queda truncado al primer ~5%.
    let params = new HttpParams()
      .set('pageSize', opts.pricedOnly ? 8000 : 5000)
      .set('commercial_only', 'true');
    if (opts.pricedOnly) params = params.set('priced_only', 'true');
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
   * Top sellers del tenant (MATERIALIZED VIEW products_top_sellers — top 1000
   * por unidades vendidas últimos 90d). Devuelve precio del price_list del
   * customer + sales_rank + units_sold + revenue.
   *
   * Hoy la MV tiene poco volumen (~7 rows en .245) hasta que Mega Dulces tenga
   * más data real. El strip del portal puede quedar vacío durante early stage.
   */
  listTopSellers(priceListId: string, warehouseId?: string, limit = 1000): Observable<PriceRow[]> {
    let params = new HttpParams().set('limit', String(limit));
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http
      .get<{ data: PriceRow[] }>(`${this.base}/price-lists/${priceListId}/top-sellers`, { params })
      .pipe(map((r: any) => (Array.isArray(r) ? r : r?.data || [])));
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

  /**
   * Productos que el customer ya compró (90d default), ordenados por frecuencia.
   * Drive del chip "Reordenar" del portal. Si nunca compró → array vacío.
   */
  myCatalogHistory(warehouseId?: string, opts: { days?: number; limit?: number } = {}): Observable<CatalogHistoryRow[]> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    if (opts.days) params = params.set('days', String(opts.days));
    if (opts.limit) params = params.set('limit', String(opts.limit));
    return this.http.get<CatalogHistoryRow[]>(`${this.base}/catalog/my-history`, { params });
  }

  /**
   * Canasta IA del customer hidratada con precio/stock (D.4). Devuelve [] si
   * el customer es nuevo sin pedidos previos (la heurística necesita historia).
   */
  myCatalogSuggested(warehouseId?: string): Observable<CatalogSuggestedRow[]> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<CatalogSuggestedRow[]>(`${this.base}/catalog/my-suggested`, { params });
  }

  /**
   * Productos con promoción activa aplicable al customer. Devuelve [] si no
   * hay promos vigentes que apunten a productos específicos (las de tipo
   * `percent_off_basket` se filtran del lado backend).
   */
  myCatalogWithPromo(warehouseId?: string): Observable<CatalogWithPromoRow[]> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<CatalogWithPromoRow[]>(`${this.base}/catalog/with-promo`, { params });
  }

  /**
   * Counts agregados del catálogo del customer (brand top-N, price buckets,
   * stock with/without). Drive del panel de filtros sin requests adicionales.
   */
  catalogFacets(warehouseId?: string, brandsLimit?: number): Observable<CatalogFacets> {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    if (brandsLimit) params = params.set('brands_limit', String(brandsLimit));
    return this.http.get<CatalogFacets>(`${this.base}/catalog/facets`, { params });
  }

  /**
   * Catálogo paginado con filtros server-side. Diferencia clave vs
   * `listCatalogProducts`: este SIEMPRE devuelve `{ data, pagination }` y
   * recibe `page` + `pageSize`. Usado por el portal-catalog desde Capa 2
   * paso 3 para evitar bajar los 7k SKUs de una.
   */
  listCatalogPage(opts: {
    warehouseId?: string;
    page?: number;
    pageSize?: number;
    q?: string;
    brandId?: string;
    priceMin?: number;
    priceMax?: number;
    hasStock?: boolean;
  }): Observable<{
    data: PriceRow[];
    pagination: { page: number; pageSize: number; total: number; pageCount: number };
  }> {
    let params = new HttpParams();
    if (opts.warehouseId) params = params.set('warehouse_id', opts.warehouseId);
    params = params.set('page', String(opts.page ?? 1));
    params = params.set('pageSize', String(opts.pageSize ?? 60));
    if (opts.q) params = params.set('q', opts.q);
    if (opts.brandId) params = params.set('brand_id', opts.brandId);
    if (opts.priceMin != null) params = params.set('price_min', String(opts.priceMin));
    if (opts.priceMax != null) params = params.set('price_max', String(opts.priceMax));
    if (opts.hasStock) params = params.set('has_stock', 'true');
    return this.http.get<{
      data: PriceRow[];
      pagination: { page: number; pageSize: number; total: number; pageCount: number };
    }>(`${this.base}/catalog/products`, { params });
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

  /**
   * Add masivo (canasta IA / promociones). Una sola refrescada al final
   * en vez de N (la versión 1:1 hacía N requests `refreshCart` que duplicaban
   * carga del endpoint /orders/my). El backend serializa con FOR UPDATE
   * sobre el draft, así que es seguro firearlas en paralelo.
   */
  addLinesBatch(
    orderId: string,
    items: Array<{ product_id: string; quantity: number; label?: string }>,
  ): Observable<Array<{ ok: true; line: OrderLine; label?: string } | { ok: false; reason: string; label?: string }>> {
    if (items.length === 0) return of([]);
    return forkJoin(
      items.map((it) =>
        this.http
          .post<OrderLine>(`${this.base}/orders/${orderId}/lines`, {
            product_id: it.product_id,
            quantity: it.quantity,
          })
          .pipe(
            map((line) => ({ ok: true as const, line, label: it.label })),
            catchError((err) =>
              of({
                ok: false as const,
                label: it.label,
                reason:
                  err?.error?.message || err?.message || 'Error desconocido',
              }),
            ),
          ),
      ),
    ).pipe(tap(() => this.refreshCart()));
  }

  /**
   * Repetir pedido completo en 1 tap (patrón q-commerce). Clona las líneas de
   * un pedido existente al carrito (draft activo) en una sola operación. Si no
   * hay draft, lo crea con el mismo customer/warehouse del pedido origen.
   * AGREGA al carrito (no reemplaza) — comportamiento tipo "añadir al carrito".
   * Si el pedido viene sin `lines` (list endpoint), las trae con orderById.
   */
  reorder(order: Order): Observable<{ added: number; failed: number }> {
    const src$ =
      order.lines && order.lines.length ? of(order) : this.orderById(order.id);
    return src$.pipe(
      switchMap((full) => {
        const lines = (full.lines || []).filter((l) => Number(l.quantity) > 0);
        if (lines.length === 0) return of({ added: 0, failed: 0 });
        return this.ensureDraft(full.customer_id, full.warehouse_id).pipe(
          switchMap((draft) =>
            this.addLinesBatch(
              draft.id,
              lines.map((l) => ({
                product_id: l.product_id,
                quantity: Number(l.quantity),
                label: l.product_id,
              })),
            ).pipe(
              map((results) => ({
                added: results.filter((r) => r.ok).length,
                failed: results.filter((r) => !r.ok).length,
              })),
            ),
          ),
        );
      }),
    );
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

  orderShipments(id: string): Observable<OrderShipmentEntry[]> {
    return this.http.get<OrderShipmentEntry[]>(`${this.base}/orders/${id}/shipments`);
  }

  // ─── Recommendations (D.4) ───

  myRecommendations(): Observable<RecommendedBasketDto> {
    return this.http.get<RecommendedBasketDto>(`${this.base}/recommendations/my`);
  }

  /** Customer 360 del cliente logueado (motor de inteligencia, Fase M). Best-effort. */
  myCustomer360(): Observable<Customer360Dto> {
    return this.http.get<Customer360Dto>(`${this.base}/intelligence/customer-360/my`);
  }

  /** Registra una señal del feedback loop para el cliente del JWT (Fase M, best-effort). */
  recordMySignal(signalType: string, channel = 'portal'): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/intelligence/signals/my`, {
      signal_type: signalType,
      channel,
    });
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
  banner_url?: string | null;
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

export interface Customer360Dto {
  customer_id: string;
  orders_count: number;
  last_order_at: string | null;
  recency_days: number | null;
  cadence_days: number | null;
  next_order_estimate: string | null;
  lifecycle_stage: 'new' | 'active' | 'at_risk' | 'lost' | 'reactivated';
}
