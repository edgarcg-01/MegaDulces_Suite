import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

// ── Tipos compartidos ────────────────────────────────────────────────
export interface AddressJsonb {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  legal_name?: string | null;
  rfc?: string | null;
  email?: string | null;
  phone?: string | null;
  billing_address?: AddressJsonb | null;
  shipping_address?: AddressJsonb | null;
  store_id?: string | null;
  default_price_list_id?: string | null;
  route_id?: string | null;
  route_name?: string | null;
  credit_limit?: number;
  payment_terms_days?: number;
  active?: boolean;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

/**
 * Tienda (PdV) de Trade Marketing. Se enlaza opcionalmente a un customer
 * comercial vía `commercial.customers.store_id`. Por ahora la lista viene
 * del endpoint legacy `/api/stores` (DB legacy); post-cutover, mismo endpoint
 * resolverá contra la nueva DB.
 */
export interface Store {
  id: string;
  nombre: string;
  direccion?: string | null;
  latitud?: string | null;
  longitud?: string | null;
  activo?: boolean;
  zona_id?: string | null;
  zona?: string | null;
  ruta_id?: string | null;
  ruta_nombre?: string | null;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  address?: string | null;
  is_default?: boolean;
  active?: boolean;
  created_at?: string;
}

export interface PriceList {
  id: string;
  code: string;
  name: string;
  currency?: string;
  is_default?: boolean;
  active?: boolean;
  created_at?: string;
}

/**
 * Producto del catálogo (admin view). Mapea a `public.products` + JOINs a
 * brand/category. Trae todos los campos M.6.2 del importer Mega_Dulces.
 */
export interface Product {
  id: string;
  sku: string | null;
  barcode: string | null;
  nombre: string;
  description: string | null;
  brand_id: string | null;
  brand_name?: string | null;
  category_id: string | null;
  category_name?: string | null;
  unit_purchase: string | null;
  unit_sale: string | null;
  factor_purchase: number | null;
  factor_sale: number | null;
  iva_rate: number | null;
  ieps_rate: number | null;
  cost_base: number | null;
  cost_with_tax: number | null;
  cost_per_case: number | null;
  location: string | null;
  location_warehouse: string | null;
  loyalty_points: number | null;
  activo: boolean;
  updated_at?: string;
  // Solo en findById:
  prices_count?: number;
  total_on_hand?: number;
  total_reserved?: number;
  total_available?: number;
}

export interface ProductsPage {
  data: Product[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
}

export interface UpdateProductDto {
  description?: string | null;
  location?: string | null;
  location_warehouse?: string | null;
  loyalty_points?: number | null;
  activo?: boolean;
}

export interface ProductPrice {
  id: string;
  price_list_id?: string;
  product_id: string;
  product_name?: string;
  product_description?: string | null;
  sku?: string | null;
  barcode?: string | null;
  brand_id?: string;
  brand_name?: string;
  category_id?: string | null;
  category_name?: string | null;
  cost_base?: number | null;
  cost_with_tax?: number | null;
  location?: string | null;
  loyalty_points?: number | null;
  price: number;
  tax_rate?: number;
  min_qty?: number;
  min_quantity?: number;
  stock_available?: number | null;
}

export interface ProductPricesPage {
  data: ProductPrice[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
}

export type OrderStatus = 'draft' | 'pending_approval' | 'confirmed' | 'fulfilled' | 'cancelled';
export type DeliveryType = 'route' | 'long_trip';

export interface Order {
  id: string;
  folio: string;
  customer_id: string;
  customer_name?: string;
  warehouse_id: string;
  warehouse_name?: string;
  status: OrderStatus;
  /** J.6.6 — tipo de entrega definido al crear el pedido. */
  delivery_type: DeliveryType;
  subtotal: number;
  discount_total?: number;
  tax_total?: number;
  total: number;
  notes?: string | null;
  user_id?: string;
  user_username?: string;
  route_id?: string | null;
  route_name?: string | null;
  created_at: string;
  confirmed_at?: string | null;
  fulfilled_at?: string | null;
  cancelled_at?: string | null;
}

export interface OrderLine {
  id: string;
  order_id: string;
  product_id: string;
  product_name?: string;
  brand_name?: string;
  quantity: number;
  /** Cantidad original que pidió el cliente (snapshot al confirmar). */
  requested_quantity?: number | string | null;
  unit_price: number;
  discount_percent: number;
  line_total: number;
  notes?: string | null;
  /** Stock total en el almacén del pedido (no descontado por reservas). */
  stock_quantity?: number | string;
  /** Stock reservado por TODOS los pedidos en pending_approval/confirmed (incluye éste). */
  stock_reserved?: number | string;
  /** Máximo al que se puede subir esta línea sin exceder stock disponible. */
  stock_available?: number | string;
}

export interface OrderDetail extends Order {
  lines: OrderLine[];
}

export interface OrderHistoryEntry {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  changed_by_user_id: string;
  changed_by_username: string;
  reason?: string | null;
  snapshot?: any;
  created_at: string;
}

export interface StockRow {
  warehouse_id: string;
  warehouse_code?: string;
  warehouse_name?: string;
  product_id: string;
  product_name?: string;
  sku?: string | null;
  brand_id?: string;
  brand_name?: string;
  /** M.6.2 — costos del producto (Mega_Dulces) para mostrar valor + margen. */
  cost_base?: number | null;
  cost_with_tax?: number | null;
  location?: string | null;
  /** Valor del stock disponible al costo (qty_available × cost_base). */
  available_value?: number;
  available: number;
  reserved: number;
  on_hand: number;
}

/**
 * Tipos de promoción soportados. Coinciden 1:1 con el CHECK del backend.
 */
export type PromotionType =
  | 'percent_off_product'
  | 'percent_off_basket'
  | 'nxm'
  | 'volume_discount'
  | 'bundle_fixed_price'
  | 'cross_sell_discount';

export interface PromotionVolumeTier {
  min_qty: number;
  percent: number;
}

export interface PromotionBundleItem {
  product_id: string;
  quantity: number;
}

/**
 * Config shape POR TIPO en el JSONB `rules`. Discriminated union — el UI
 * adapta el form según `promotion_type`.
 */
export type PromotionRules =
  | { product_id: string; percent: number } // percent_off_product
  | { percent: number } // percent_off_basket
  | { product_id: string; n_buy: number; m_pay: number } // nxm
  | { product_id: string; tiers: PromotionVolumeTier[] } // volume_discount
  | { items: PromotionBundleItem[]; price: number } // bundle_fixed_price
  | { trigger_product_id: string; target_product_id: string; percent: number }; // cross_sell_discount

export interface Promotion {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  promotion_type: PromotionType;
  rules: PromotionRules;
  priority: number;
  starts_at?: string | null;
  ends_at?: string | null;
  usage_limit?: number | null;
  usage_count: number;
  min_order_amount?: number | null;
  applies_to: 'all_customers' | 'specific_customers';
  applies_to_customer_ids?: string[] | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export type StockMovementType = 'in' | 'out' | 'adjust' | 'reserve' | 'release' | 'sale';

export interface StockMovement {
  id: string;
  warehouse_id: string;
  warehouse_name?: string;
  product_id: string;
  product_name?: string;
  movement_type: StockMovementType;
  quantity: number;
  reference_type?: string | null;
  reference_id?: string | null;
  notes?: string | null;
  created_at: string;
  created_by_username?: string;
}

export interface Paged<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
}

@Injectable({ providedIn: 'root' })
export class ComercialService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial`;

  // ── Customers ──────────────────────────────────────────────────────
  listCustomers(opts: { page?: number; pageSize?: number; search?: string; active?: boolean } = {}): Observable<Paged<Customer>> {
    let params = new HttpParams();
    if (opts.page) params = params.set('page', String(opts.page));
    if (opts.pageSize) params = params.set('pageSize', String(opts.pageSize));
    if (opts.search) params = params.set('search', opts.search);
    if (opts.active !== undefined) params = params.set('active', String(opts.active));
    return this.http.get<Paged<Customer>>(`${this.base}/customers`, { params });
  }
  getCustomer(id: string) {
    return this.http.get<Customer>(`${this.base}/customers/${id}`);
  }
  createCustomer(body: Partial<Customer>) {
    return this.http.post<Customer>(`${this.base}/customers`, body);
  }
  updateCustomer(id: string, body: Partial<Customer>) {
    return this.http.patch<Customer>(`${this.base}/customers/${id}`, body);
  }
  deleteCustomer(id: string) {
    return this.http.delete<{ ok: true }>(`${this.base}/customers/${id}`);
  }
  /** J.6.3 — crea user Portal B2B vinculado al customer. */
  createPortalAccess(customerId: string, body: { username?: string; password?: string } = {}) {
    return this.http.post<{
      user_id: string;
      username: string;
      temporary_password: string;
      message: string;
    }>(`${this.base}/customers/${customerId}/portal-access`, body);
  }

  // ── Stores (Trade Marketing) ───────────────────────────────────────
  // Endpoint legacy: NO está bajo /commercial. Lo usamos read-only para
  // enlazar customers comerciales con PdV físicos auditados.
  listStores(): Observable<Store[]> {
    return this.http.get<Store[]>(`${environment.apiUrl}/stores`);
  }

  // ── Catálogo de productos (Trade Marketing) ────────────────────────
  // Devuelve brands con productos anidados. Usado para selectors en promociones.
  listProductCatalog(): Observable<Array<{ id: string; nombre: string; productos: Array<{ id: string; nombre: string; activo: boolean }> }>> {
    return this.http.get<any[]>(`${environment.apiUrl}/planograms/brands`);
  }

  // ── Warehouses ─────────────────────────────────────────────────────
  listWarehouses(active?: boolean) {
    let params = new HttpParams();
    if (active !== undefined) params = params.set('active', String(active));
    // Backend retorna array directo (mismo patrón que listPriceLists).
    return this.http.get<Warehouse[]>(`${this.base}/warehouses`, { params });
  }
  createWarehouse(body: Partial<Warehouse>) {
    return this.http.post<Warehouse>(`${this.base}/warehouses`, body);
  }
  updateWarehouse(id: string, body: Partial<Warehouse>) {
    return this.http.patch<Warehouse>(`${this.base}/warehouses/${id}`, body);
  }
  deleteWarehouse(id: string) {
    return this.http.delete<{ ok: true }>(`${this.base}/warehouses/${id}`);
  }

  // ── Pricing ────────────────────────────────────────────────────────
  listPriceLists(active?: boolean) {
    let params = new HttpParams();
    if (active !== undefined) params = params.set('active', String(active));
    // Backend retorna array directo (no envuelto en { data }). Era bug:
    // el component hacía `r.data || []` y siempre caía al fallback vacío.
    return this.http.get<PriceList[]>(`${this.base}/price-lists`, { params });
  }
  createPriceList(body: Partial<PriceList>) {
    return this.http.post<PriceList>(`${this.base}/price-lists`, body);
  }
  updatePriceList(id: string, body: Partial<PriceList>) {
    return this.http.patch<PriceList>(`${this.base}/price-lists/${id}`, body);
  }
  deletePriceList(id: string) {
    return this.http.delete<{ ok: true }>(`${this.base}/price-lists/${id}`);
  }
  listPrices(priceListId: string, opts: { warehouseId?: string; page?: number; pageSize?: number; search?: string } = {}) {
    let params = new HttpParams();
    if (opts.warehouseId) params = params.set('warehouse_id', opts.warehouseId);
    if (opts.page != null) params = params.set('page', opts.page);
    if (opts.pageSize != null) params = params.set('pageSize', opts.pageSize);
    if (opts.search?.trim()) params = params.set('search', opts.search.trim());
    return this.http.get<ProductPricesPage>(`${this.base}/price-lists/${priceListId}/prices`, { params });
  }
  bulkUpsertPrices(body: { price_list_id: string; items: { product_id: string; price: number; min_quantity?: number }[] }) {
    return this.http.post<{ upserted: number }>(`${this.base}/product-prices/bulk-upsert`, body);
  }
  deletePrice(id: string) {
    return this.http.delete<{ ok: true }>(`${this.base}/product-prices/${id}`);
  }

  // ── Products (admin catalog) ───────────────────────────────────────
  listProducts(opts: {
    page?: number;
    pageSize?: number;
    search?: string;
    brand_id?: string;
    category_id?: string;
    active?: boolean;
    with_cost?: boolean;
  } = {}) {
    let params = new HttpParams();
    if (opts.page != null) params = params.set('page', opts.page);
    if (opts.pageSize != null) params = params.set('pageSize', opts.pageSize);
    if (opts.search?.trim()) params = params.set('search', opts.search.trim());
    if (opts.brand_id) params = params.set('brand_id', opts.brand_id);
    if (opts.category_id) params = params.set('category_id', opts.category_id);
    if (opts.active !== undefined) params = params.set('active', String(opts.active));
    if (opts.with_cost) params = params.set('with_cost', 'true');
    return this.http.get<ProductsPage>(`${this.base}/products`, { params });
  }
  findProduct(id: string) {
    return this.http.get<Product>(`${this.base}/products/${id}`);
  }
  updateProduct(id: string, body: UpdateProductDto) {
    return this.http.patch<Product>(`${this.base}/products/${id}`, body);
  }

  // ── Inventory ──────────────────────────────────────────────────────
  listStock(opts: { warehouse_id?: string; product_id?: string; page?: number; pageSize?: number } = {}) {
    let params = new HttpParams();
    if (opts.warehouse_id) params = params.set('warehouse_id', opts.warehouse_id);
    if (opts.product_id) params = params.set('product_id', opts.product_id);
    if (opts.page) params = params.set('page', String(opts.page));
    if (opts.pageSize) params = params.set('pageSize', String(opts.pageSize));
    return this.http.get<Paged<StockRow>>(`${this.base}/inventory/stock`, { params });
  }
  adjustStock(body: { warehouse_id: string; product_id: string; new_quantity: number; notes?: string }) {
    return this.http.post<StockRow>(`${this.base}/inventory/adjust`, body);
  }
  recordMovement(body: { warehouse_id: string; product_id: string; movement_type: StockMovementType; quantity: number; notes?: string }) {
    return this.http.post<StockMovement>(`${this.base}/inventory/movements`, body);
  }
  listMovements(opts: { warehouse_id?: string; product_id?: string; movement_type?: StockMovementType; page?: number; pageSize?: number } = {}) {
    let params = new HttpParams();
    if (opts.warehouse_id) params = params.set('warehouse_id', opts.warehouse_id);
    if (opts.product_id) params = params.set('product_id', opts.product_id);
    if (opts.movement_type) params = params.set('movement_type', opts.movement_type);
    if (opts.page) params = params.set('page', String(opts.page));
    if (opts.pageSize) params = params.set('pageSize', String(opts.pageSize));
    return this.http.get<Paged<StockMovement>>(`${this.base}/inventory/movements`, { params });
  }

  // ── Orders ─────────────────────────────────────────────────────────
  listOrders(opts: { status?: OrderStatus; customer_id?: string; from?: string; to?: string; page?: number; pageSize?: number } = {}) {
    let params = new HttpParams();
    if (opts.status) params = params.set('status', opts.status);
    if (opts.customer_id) params = params.set('customer_id', opts.customer_id);
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.page) params = params.set('page', String(opts.page));
    if (opts.pageSize) params = params.set('pageSize', String(opts.pageSize));
    return this.http.get<Paged<Order>>(`${this.base}/orders`, { params });
  }
  getOrder(id: string) {
    return this.http.get<OrderDetail>(`${this.base}/orders/${id}`);
  }
  getOrderHistory(id: string) {
    return this.http.get<{ data: OrderHistoryEntry[] }>(`${this.base}/orders/${id}/history`);
  }
  confirmOrder(id: string) {
    return this.http.post<Order>(`${this.base}/orders/${id}/confirm`, {});
  }
  approveOrder(id: string) {
    return this.http.post<Order>(`${this.base}/orders/${id}/approve`, {});
  }
  fulfillOrder(id: string) {
    return this.http.post<Order>(`${this.base}/orders/${id}/fulfill`, {});
  }
  cancelOrder(id: string, reason?: string) {
    return this.http.post<Order>(`${this.base}/orders/${id}/cancel`, { reason });
  }
  updateOrderLine(orderId: string, lineId: string, body: { quantity?: number; discount_percent?: number; notes?: string }) {
    return this.http.patch<OrderLine>(`${this.base}/orders/${orderId}/lines/${lineId}`, body);
  }
  removeOrderLine(orderId: string, lineId: string) {
    return this.http.delete<{ deleted: boolean; id: string }>(`${this.base}/orders/${orderId}/lines/${lineId}`);
  }

  // ── Promotions ─────────────────────────────────────────────────────
  listPromotions(opts: {
    page?: number;
    pageSize?: number;
    active?: boolean;
    promotion_type?: PromotionType;
    onlyActive?: boolean;
  } = {}): Observable<Paged<Promotion>> {
    let params = new HttpParams();
    if (opts.page) params = params.set('page', String(opts.page));
    if (opts.pageSize) params = params.set('pageSize', String(opts.pageSize));
    if (opts.active !== undefined) params = params.set('active', String(opts.active));
    if (opts.promotion_type) params = params.set('promotion_type', opts.promotion_type);
    if (opts.onlyActive) params = params.set('onlyActive', 'true');
    return this.http.get<Paged<Promotion>>(`${this.base}/promotions`, { params });
  }
  getPromotion(id: string) {
    return this.http.get<Promotion>(`${this.base}/promotions/${id}`);
  }
  createPromotion(body: Partial<Promotion>) {
    return this.http.post<Promotion>(`${this.base}/promotions`, body);
  }
  updatePromotion(id: string, body: Partial<Promotion>) {
    return this.http.patch<Promotion>(`${this.base}/promotions/${id}`, body);
  }
  setPromotionActive(id: string, active: boolean) {
    return this.http.patch<Promotion>(`${this.base}/promotions/${id}/active`, { active });
  }
  deletePromotion(id: string) {
    return this.http.delete<{ ok: true }>(`${this.base}/promotions/${id}`);
  }

  // ── Cierre de ruta (admin) ──
  listRouteTickets(opts: {
    ticket_type?: 'venta' | 'carga' | 'combustible';
    route_code?: string;
    date_from?: string;
    date_to?: string;
    page?: number;
    pageSize?: number;
  } = {}): Observable<{ data: RouteTicketAdmin[]; total: number; page: number; pageSize: number }> {
    let p = new HttpParams().set('pageSize', String(opts.pageSize ?? 50));
    if (opts.page) p = p.set('page', String(opts.page));
    if (opts.ticket_type) p = p.set('ticket_type', opts.ticket_type);
    if (opts.route_code) p = p.set('route_code', opts.route_code);
    if (opts.date_from) p = p.set('date_from', opts.date_from);
    if (opts.date_to) p = p.set('date_to', opts.date_to);
    return this.http.get<{ data: RouteTicketAdmin[]; total: number; page: number; pageSize: number }>(
      `${this.base}/route-tickets/all`,
      { params: p },
    );
  }

  routeResumen(opts: { date_from?: string; date_to?: string } = {}): Observable<RouteResumen> {
    let p = new HttpParams();
    if (opts.date_from) p = p.set('date_from', opts.date_from);
    if (opts.date_to) p = p.set('date_to', opts.date_to);
    return this.http.get<RouteResumen>(`${this.base}/route-tickets/reports/resumen`, { params: p });
  }

  routePorRuta(opts: { date_from?: string; date_to?: string } = {}): Observable<RoutePorRutaRow[]> {
    let p = new HttpParams();
    if (opts.date_from) p = p.set('date_from', opts.date_from);
    if (opts.date_to) p = p.set('date_to', opts.date_to);
    return this.http.get<RoutePorRutaRow[]>(`${this.base}/route-tickets/reports/por-ruta`, { params: p });
  }
}

export interface RouteTicketAdmin {
  id: string;
  ticket_type: 'venta' | 'carga' | 'combustible';
  route_code: string;
  ticket_date: string;
  total: number | null;
  corte_number: string | null;
  reference: string | null;
  liters: number | null;
  vendor_user_id: string;
  vendor_name?: string | null;
  vendor_username?: string | null;
  photo_url?: string | null;
  created_at: string;
}

export interface RouteResumen {
  por_tipo: { ticket_type: string; tickets: number; total: number }[];
  ventas: number;
  gasto: number;
  rentabilidad: number;
  tickets: number;
}

export interface RoutePorRutaRow {
  route_code: string;
  total: number | string;
  tickets: number | string;
}
