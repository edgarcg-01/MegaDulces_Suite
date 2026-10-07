import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, defer, from, map, mergeMap, of, switchMap, tap, throwError, toArray } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import { TelemetryService } from '../../core/telemetry/telemetry.service';
import { HttpCacheService } from '../../core/http/http-cache.service';
import { OutboxService } from '../../core/offline/outbox.service';

// ─────────── Tipos ───────────

export interface ThotToolTrace { name: string; input: any; result: any; }
export interface ThotChatResult {
  answer: string;
  source: 'llm' | 'no_api_key' | 'error';
  tools_used: ThotToolTrace[];
  iterations: number;
  log_id?: string | null;
}

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
  /** Aún no lo expone findById (la imagen vive en inventory.products_active);
      la UI lo usa si llega, sino cae al monograma. */
  image_url?: string | null;
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
  /** FE.7 — UUID del CFDI emitido para este pedido (null si aún no facturado). */
  cfdi_uuid?: string | null;
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

/** FE.7 — datos fiscales que el cliente confirma/edita al pedir su factura. */
export interface SelfInvoiceFiscal {
  rfc?: string;
  legal_name?: string;
  regimen_fiscal?: string;
  uso_cfdi?: string;
  zip?: string;
}

@Injectable({ providedIn: 'root' })
export class PortalService {
  private readonly http = inject(HttpClient);
  private readonly telemetry = inject(TelemetryService);
  private readonly cache = inject(HttpCacheService);
  private readonly outbox = inject(OutboxService);
  private readonly base = environment.apiUrl + '/commercial';

  // TTLs de cache (E6). Reference data cambia poco; catálogo/facets, moderado.
  private static readonly TTL_REF = 5 * 60_000;
  private static readonly TTL_CATALOG = 60_000;

  readonly cartLineCount = signal<number>(0);
  readonly cartTotal = signal<number>(0);
  readonly cartId = signal<string | null>(null);
  readonly cartDetail = signal<Order | null>(null);

  /** TC-P — Asistente conversacional (scoped al cliente del JWT, surtido PH). */
  thotChat(history: { role: 'user' | 'assistant'; content: string }[], message: string): Observable<ThotChatResult> {
    return this.http.post<ThotChatResult>(`${this.base}/intelligence/portal/thot/chat`, { history, message });
  }
  thotFeedback(logId: string, vote: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/intelligence/thot/feedback`, { log_id: logId, vote });
  }

  /**
   * Reconcilia el carrito con la verdad del servidor.
   *
   * E2 — colapso de round-trips: si ya conocemos el draft (`cartId`), pegamos
   * UN solo `orderById` (1 hop) en vez de `getActiveDraft` → `orderById` (2 hops).
   * Cada "+1/-1" del catálogo dispara este reconcile, así que reducirlo a la
   * mitad es lo que más se siente en conexiones lentas (estándar q-commerce).
   * El camino de 2 hops solo corre en frío (cartId desconocido) o si el fast
   * path falla.
   */
  refreshCart(): void {
    const known = this.cartId();
    if (known) {
      this.orderById(known).subscribe({
        next: (full) => this.setCartFromOrder(full),
        error: () => this.resolveCartFromScratch(),
      });
      return;
    }
    this.resolveCartFromScratch();
  }

  private resolveCartFromScratch(): void {
    this.getActiveDraft().subscribe({
      next: (d) => {
        if (!d) {
          this.clearCart();
          return;
        }
        this.cartId.set(d.id);
        // `/orders/my` (list endpoint) no popula `lines` — solo trae el header.
        // Para count/total reales encadenamos `orderById`.
        this.orderById(d.id).subscribe({
          next: (full) => this.setCartFromOrder(full),
          error: () => {
            this.cartDetail.set(null);
            this.cartLineCount.set(0);
            this.cartTotal.set(Number(d.total) || 0);
          },
        });
      },
      error: () => this.clearCart(),
    });
  }

  private setCartFromOrder(full: Order): void {
    this.cartId.set(full.id);
    this.cartDetail.set(full);
    this.cartLineCount.set(Array.isArray(full.lines) ? full.lines.length : 0);
    this.cartTotal.set(Number(full.total) || 0);
  }

  private clearCart(): void {
    this.cartLineCount.set(0);
    this.cartTotal.set(0);
    this.cartId.set(null);
    this.cartDetail.set(null);
  }

  // ── Updates optimistas ──────────────────────────────────────────────────────
  // Mueven los signals del carrito ANTES de la respuesta del server, para que el
  // badge/FAB respondan al instante (sensación Rappi). El `refreshCart()` que
  // corre en el `tap` de cada mutación reconcilia con la verdad del backend
  // (precio, impuesto, promos) — y revierte si la operación falló.

  private optimisticBumpForAdd(productId: string): void {
    const cur = this.cartDetail();
    const exists = !!cur?.lines?.some((l) => l.product_id === productId);
    // Si el producto ya estaba, el backend hace merge de cantidad → el count no
    // cambia. Si es nuevo, +1 inmediato.
    if (!exists) this.cartLineCount.update((n) => n + 1);
  }

  private optimisticRemove(lineId: string): void {
    const cur = this.cartDetail();
    if (!cur?.lines) return;
    const line = cur.lines.find((l) => l.id === lineId);
    if (!line) return;
    const newLines = cur.lines.filter((l) => l.id !== lineId);
    this.cartDetail.set({ ...cur, lines: newLines });
    this.cartLineCount.set(newLines.length);
    this.cartTotal.update((t) => Math.max(0, t - (Number(line.line_total) || 0)));
  }

  private optimisticUpdate(lineId: string, newQty: number): void {
    const cur = this.cartDetail();
    if (!cur?.lines) return;
    const idx = cur.lines.findIndex((l) => l.id === lineId);
    if (idx < 0) return;
    const line = cur.lines[idx];
    const oldQty = Number(line.quantity) || 0;
    if (oldQty <= 0) return;
    const oldTotal = Number(line.line_total) || 0;
    // Escala proporcional: aproximación del nuevo total (el backend recalcula
    // impuesto/promo exactos en el reconcile). Suficiente para el feedback.
    const newTotal = oldTotal * (newQty / oldQty);
    const newLines = [...cur.lines];
    newLines[idx] = { ...line, quantity: newQty, line_total: newTotal };
    this.cartDetail.set({ ...cur, lines: newLines });
    this.cartTotal.update((t) => Math.max(0, t - oldTotal + newTotal));
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
    return this.cache.wrap('price-lists', PortalService.TTL_REF, () =>
      this.http.get<any[]>(`${this.base}/price-lists`),
    );
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
    let params = new HttpParams().set('pageSize', 5000).set('commercial_only', 'true');
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
   * Precios de un set específico de product_ids (E4 — anti over-fetch).
   *
   * Promociones solo necesita el precio de los ~20 productos referenciados por
   * las promos, pero antes traía las ~7k filas del price-list con
   * `listPricesForList` (pageSize=5000, que además TRUNCA si hay >5000 SKUs →
   * promos sin precio en silencio). Esto pide solo lo necesario.
   *
   *  ── HANDOFF BACKEND: implementar `POST /price-lists/:id/prices/by-ids`
   *     { product_ids, warehouse_id } que devuelva solo esas filas. Mientras no
   *     exista (404/405), caemos al listado completo (comportamiento actual).
   */
  pricesByIds(priceListId: string, productIds: string[], warehouseId?: string): Observable<PriceRow[]> {
    const ids = Array.from(new Set(productIds.filter(Boolean)));
    if (ids.length === 0) return of([]);
    const body: Record<string, unknown> = { product_ids: ids };
    if (warehouseId) body['warehouse_id'] = warehouseId;
    return this.http
      .post<{ data: PriceRow[] } | PriceRow[]>(`${this.base}/price-lists/${priceListId}/prices/by-ids`, body)
      .pipe(
        map((r: any) => (Array.isArray(r) ? r : r?.data || [])),
        catchError((err) => {
          if (err?.status === 404 || err?.status === 405) {
            return this.listPricesForList(priceListId, warehouseId);
          }
          return throwError(() => err);
        }),
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
    return this.cache.wrap(
      `catalog-products:${warehouseId ?? 'all'}`,
      PortalService.TTL_CATALOG,
      () => this.http.get<PriceRow[]>(`${this.base}/catalog/products`, { params }),
    );
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
    return this.cache.wrap(
      `catalog-facets:${warehouseId ?? 'all'}:${brandsLimit ?? 'def'}`,
      PortalService.TTL_CATALOG,
      () => this.http.get<CatalogFacets>(`${this.base}/catalog/facets`, { params }),
    );
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
    return this.cache.wrap('warehouses', PortalService.TTL_REF, () =>
      this.http.get<any[]>(`${this.base}/warehouses`),
    );
  }

  /**
   * Customer linkeado al JWT del user (users.customer_id). Bypass del listado
   * paginado que devolvía "el primero del tenant" — causaba drafts en customer
   * ≠ al customer del user → /orders/my nunca los veía y el carrito quedaba
   * vacío visualmente aunque DB tuviera lines. Backend resuelve por user_id
   * del CLS.
   */
  myCustomerInfo() {
    return this.cache.wrap('customers-me', PortalService.TTL_REF, () =>
      this.http.get<any>(`${this.base}/customers/me`),
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
    const url = `${this.base}/orders/${orderId}/lines`;
    const body = { product_id: productId, quantity };
    return defer(() => {
      this.optimisticBumpForAdd(productId);
      // Offline (F2): encolar y resolver optimista; se reproduce al reconectar.
      if (!this.outbox.isOnline()) {
        void this.outbox.enqueue({ method: 'POST', url, body, label: productId });
        this.telemetry.track('cart_line_added', { product_id: productId, quantity, queued: true });
        return of(null as unknown as OrderLine);
      }
      return this.http.post<OrderLine>(url, body).pipe(
        tap({
          next: () => {
            this.refreshCart();
            this.telemetry.track('cart_line_added', { product_id: productId, quantity });
          },
          error: () => this.refreshCart(), // reconcilia/revierte el optimismo
        }),
      );
    });
  }

  /**
   * Add masivo (canasta IA / promociones). Una sola refrescada al final.
   *
   * E4 — concurrencia acotada: antes era `forkJoin` (N POST en paralelo sin
   * límite). Con 80 líneas eso dispara 80 requests que el browser tapona a 6
   * conexiones y satura el pool del backend. Ahora `mergeMap` con concurrencia
   * 4: rápido pero sin avalancha. El orden del array de salida no importa (los
   * callers solo cuentan ok/failed y leen `label` por item fallido).
   *
   *  ── HANDOFF BACKEND: un endpoint `POST /orders/:id/lines/bulk` que reciba
   *     todas las líneas en una request sería 1 round-trip en vez de N.
   */
  addLinesBatch(
    orderId: string,
    items: Array<{ product_id: string; quantity: number; label?: string }>,
  ): Observable<Array<{ ok: true; line: OrderLine; label?: string } | { ok: false; reason: string; label?: string }>> {
    if (items.length === 0) return of([]);
    const CONCURRENCY = 4;
    return from(items).pipe(
      mergeMap(
        (it) =>
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
                  reason: err?.error?.message || err?.message || 'Error desconocido',
                }),
              ),
            ),
        CONCURRENCY,
      ),
      toArray(),
      tap(() => this.refreshCart()),
    );
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
    const url = `${this.base}/orders/${orderId}/lines/${lineId}`;
    return defer(() => {
      this.optimisticUpdate(lineId, quantity);
      if (!this.outbox.isOnline()) {
        void this.outbox.enqueue({ method: 'PATCH', url, body: { quantity }, label: lineId });
        return of(null as unknown as OrderLine);
      }
      return this.http
        .patch<OrderLine>(url, { quantity })
        .pipe(tap({ next: () => this.refreshCart(), error: () => this.refreshCart() }));
    });
  }

  removeLine(orderId: string, lineId: string) {
    const url = `${this.base}/orders/${orderId}/lines/${lineId}`;
    return defer(() => {
      this.optimisticRemove(lineId);
      if (!this.outbox.isOnline()) {
        void this.outbox.enqueue({ method: 'DELETE', url, label: lineId });
        return of({ deleted: true });
      }
      return this.http
        .delete<{ deleted: boolean }>(url)
        .pipe(tap({ next: () => this.refreshCart(), error: () => this.refreshCart() }));
    });
  }

  confirm(orderId: string): Observable<Order> {
    // F2: confirmar requiere conexión — la validación de stock/precio/promos es
    // server-side, no se confirma a ciegas offline (sí se puede armar el carrito).
    if (!this.outbox.isOnline()) {
      return throwError(() => new Error('Necesitas conexión para confirmar el pedido.'));
    }
    return this.http
      .post<Order>(`${this.base}/orders/${orderId}/confirm`, {})
      .pipe(tap((order) => {
        // El draft dejó de ser draft: limpiamos cartId para forzar la
        // resolución desde cero (getActiveDraft → null → carrito vacío). Sin
        // esto el fast path de refreshCart resucitaría el pedido ya confirmado.
        this.cartId.set(null);
        this.refreshCart();
        // Evento bottom-of-funnel: la conversión real del portal.
        this.telemetry.track('order_confirmed', {
          order_id: orderId,
          total: Number(order?.total) || 0,
        });
      }));
  }

  cancel(orderId: string, reason?: string) {
    return this.http
      .post<Order>(`${this.base}/orders/${orderId}/cancel`, { reason })
      .pipe(tap(() => {
        this.cartId.set(null); // mismo motivo que en confirm()
        this.refreshCart();
      }));
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

  // ─── FE.7: facturación self-service ───

  /** El cliente factura SU pedido entregado. Datos fiscales opcionales (se guardan en su customer). */
  selfInvoice(orderId: string, fiscal?: SelfInvoiceFiscal): Observable<{ uuid: string; serie: string; folio: string; total: number }> {
    return this.http.post<{ uuid: string; serie: string; folio: string; total: number }>(
      `${this.base}/orders/${orderId}/self-invoice`, fiscal || {},
    );
  }
  cfdiXml(orderId: string): Observable<string> {
    return this.http.get(`${this.base}/orders/${orderId}/cfdi-xml`, { responseType: 'text' });
  }
  cfdiPdf(orderId: string): Observable<{ pdf_base64: string }> {
    return this.http.get<{ pdf_base64: string }>(`${this.base}/orders/${orderId}/cfdi-pdf`);
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
    return this.http
      .post<SmartSearchResponse>(`${this.base}/catalog/search`, { query, limit })
      .pipe(tap((res) =>
        this.telemetry.track('catalog_search', {
          query_len: query.length,
          mode: res?.mode,
          results: res?.results?.length ?? 0,
        }),
      ));
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
