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
  whatsapp?: string | null;
  sales_route?: string | null;
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
  /** Username del acceso Portal B2B enlazado (null si no tiene). Read-only. */
  portal_username?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
}

/** Respuesta de crear/resetear acceso Portal B2B (password one-time). */
export interface PortalAccessResult {
  user_id: string;
  username: string;
  temporary_password: string;
  message: string;
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

export interface ProductStats {
  total: number;
  active: number;
  inactive: number;
  with_cost: number;
  with_location: number;
  brands: number;
  categories: number;
  top_brands: { name: string; sku_count: number }[];
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

/** J16 — serie diaria de pedidos para sparkline de KPI. */
export interface OrderKpiSeries {
  range: { from: string; to: string };
  dates: string[];
  amount: number[];
  count: number[];
}

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
  banner_url?: string | null;
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

export interface ExpiringLot {
  id: string;
  lot_code: string;
  expiry_date: string;
  quantity: number | string;
  warehouse_id: string;
  warehouse_code: string;
  product_id: string;
  sku: string | null;
  product_name: string | null;
  days_to_expiry: number;
  value_at_cost: number | string;
}

export interface AbcRow {
  warehouse_id: string;
  warehouse_code: string;
  product_id: string;
  sku: string | null;
  product_name: string | null;
  abc_class: 'A' | 'B' | 'C';
  annual_value: number | string;
  units_window: number | string;
  value_share: number | string;
  window_days: number;
  computed_at: string;
}

export interface AbcSummary {
  by_class: Record<'A' | 'B' | 'C', { count: number; value: number }>;
  total_count: number;
  total_value: number;
  computed_at: string | null;
}

export interface CycleDueItem {
  warehouse_id: string;
  warehouse_code: string;
  product_id: string;
  sku: string | null;
  product_name: string | null;
  abc_class: 'A' | 'B' | 'C';
  annual_value: number | string;
  last_counted_at: string | null;
  cadence_days: number;
  next_due: string | null;
  is_due: boolean;
  days_overdue: number | null;
}

export interface CycleDueResult {
  cadence_days: Record<'A' | 'B' | 'C', number>;
  only_due: boolean;
  count: number;
  by_class: Record<'A' | 'B' | 'C', number>;
  items: CycleDueItem[];
}

export interface WarehouseAisle {
  id: string;
  code: string;
  name: string | null;
  grid_row: number;
  grid_col: number;
  span_rows: number;
  span_cols: number;
  active: boolean;
  sku_count?: number;
  units?: number | string;
}

export interface AisleList {
  aisles: WarehouseAisle[];
  unassigned: { sku_count: number; units: number | string };
}

export interface AisleBrand { id: string; nombre: string; sku_count: number; }

export interface AisleTeamPerson { user_id: string; name: string; }
export interface AisleTeam {
  aisle_id: string; code: string; name: string;
  grid_row: number; grid_col: number; span_rows: number; span_cols: number;
  supervisor: AisleTeamPerson | null;
  counters: AisleTeamPerson[];
}
export interface AisleTeamBoard { warehouse_id: string; status: string; aisles: AisleTeam[]; }

export interface Paged<T> {
  data: T[];
  total_amount?: number;
  pagination: { page: number; pageSize: number; total: number; pageCount: number };
}

/** TC.2 — Thot Chat (analítica conversacional). */
export interface ThotChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
export interface ThotToolTrace {
  name: string;
  input: any;
  result: any;
}
export interface ThotChatResult {
  answer: string;
  source: 'llm' | 'no_api_key' | 'error';
  tools_used: ThotToolTrace[];
  iterations: number;
}

@Injectable({ providedIn: 'root' })
export class ComercialService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial`;

  // ── Thot Chat ──────────────────────────────────────────────────────
  thotChat(
    history: ThotChatTurn[],
    message: string,
    opts?: { think?: boolean; deepSearch?: boolean; image?: { mediaType: string; data: string } | null },
  ): Observable<ThotChatResult> {
    return this.http.post<ThotChatResult>(`${this.base}/intelligence/thot/chat`, {
      history,
      message,
      think: opts?.think ?? false,
      deep_search: opts?.deepSearch ?? false,
      image: opts?.image ? { media_type: opts.image.mediaType, data: opts.image.data } : undefined,
    });
  }

  /** Dictado por voz → texto (Groq Whisper). `audio` = base64 sin prefijo data:. */
  transcribe(audio: string, mime: string): Observable<{ text: string; error?: string }> {
    return this.http.post<{ text: string; error?: string }>(
      `${this.base}/intelligence/thot/transcribe`,
      { audio, mime },
    );
  }

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
  /** Altas de clientes por día (mini-charts del KPI strip). */
  newCustomersDaily(days = 30): Observable<Array<{ day: string; count: number }>> {
    const params = new HttpParams().set('days', String(days));
    return this.http.get<Array<{ day: string; count: number }>>(`${this.base}/customers/stats/new-daily`, { params });
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
    return this.http.post<PortalAccessResult>(
      `${this.base}/customers/${customerId}/portal-access`,
      body,
    );
  }
  /** J.6.3b — resetea el password del acceso Portal B2B (devuelve nuevo temporal). */
  resetPortalAccess(customerId: string, body: { password?: string } = {}) {
    return this.http.post<PortalAccessResult>(
      `${this.base}/customers/${customerId}/portal-access/reset-password`,
      body,
    );
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
  productStats(search?: string) {
    let params = new HttpParams();
    if (search?.trim()) params = params.set('search', search.trim());
    return this.http.get<ProductStats>(`${this.base}/products/stats`, { params });
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
  /** P2.2 — lotes próximos a vencer / vencidos (FEFO), con valor en riesgo al costo. */
  listExpiringLots(opts: { days?: number; warehouse_id?: string } = {}) {
    let params = new HttpParams();
    if (opts.days != null) params = params.set('days', String(opts.days));
    if (opts.warehouse_id) params = params.set('warehouse_id', opts.warehouse_id);
    return this.http.get<ExpiringLot[]>(`${this.base}/inventory/expiring`, { params });
  }

  // ── ABC + conteo cíclico (Fase ABC) ─────────────────────────────────
  abcSummary(warehouseId?: string) {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<AbcSummary>(`${this.base}/inventory/abc/summary`, { params });
  }
  listAbc(opts: { warehouse_id?: string; abc_class?: string } = {}) {
    let params = new HttpParams();
    if (opts.warehouse_id) params = params.set('warehouse_id', opts.warehouse_id);
    if (opts.abc_class) params = params.set('abc_class', opts.abc_class);
    return this.http.get<AbcRow[]>(`${this.base}/inventory/abc`, { params });
  }
  refreshAbc(windowDays?: number) {
    return this.http.post<{ classified: number; window_days: number; by_class: Record<string, { count: number; value: number }> }>(
      `${this.base}/inventory/abc/refresh`, { window_days: windowDays });
  }
  cycleDue(opts: { warehouse_id?: string; abc_class?: string; only_due?: boolean } = {}) {
    let params = new HttpParams();
    if (opts.warehouse_id) params = params.set('warehouse_id', opts.warehouse_id);
    if (opts.abc_class) params = params.set('abc_class', opts.abc_class);
    if (opts.only_due === false) params = params.set('only_due', 'false');
    return this.http.get<CycleDueResult>(`${this.base}/inventory/abc/cycle-due`, { params });
  }
  generateCycleFolios(body: { warehouse_id?: string; max_items?: number }) {
    return this.http.post<{ warehouses_due: number; folios_created: number; skipped: number; errors: number }>(
      `${this.base}/inventory/abc/generate-cycle-folios`, body);
  }

  // ── Pasillos 2D (Fase PA) ───────────────────────────────────────────
  listAisles(warehouseId: string) {
    return this.http.get<AisleList>(`${this.base}/inventory/aisles`, { params: new HttpParams().set('warehouse_id', warehouseId) });
  }
  aisleBrands(warehouseId: string) {
    return this.http.get<AisleBrand[]>(`${this.base}/inventory/aisles/brands`, { params: new HttpParams().set('warehouse_id', warehouseId) });
  }
  createAisle(body: { warehouse_id: string; code: string; name?: string; grid_row?: number; grid_col?: number; span_rows?: number; span_cols?: number }) {
    return this.http.post<WarehouseAisle>(`${this.base}/inventory/aisles`, body);
  }
  updateAisle(id: string, body: Partial<{ code: string; name: string; grid_row: number; grid_col: number; span_rows: number; span_cols: number; active: boolean }>) {
    return this.http.patch<WarehouseAisle>(`${this.base}/inventory/aisles/${id}`, body);
  }
  deleteAisle(id: string) {
    return this.http.delete<{ ok: boolean }>(`${this.base}/inventory/aisles/${id}`);
  }
  assignSkusToAisle(body: { warehouse_id: string; aisle_id: string | null; filter: { product_ids?: string[]; brand_id?: string; abc_class?: string; sku_from?: string; sku_to?: string; only_unassigned?: boolean } }) {
    return this.http.post<{ updated: number }>(`${this.base}/inventory/aisles/assign`, body);
  }

  // ── Tablero de equipos por folio (Fase PA.3) ────────────────────────
  inventoryAisleTeams(countId: string) {
    return this.http.get<AisleTeamBoard>(`${this.base}/inventory/counts/${countId}/aisle-teams`);
  }
  inventoryGenerateTeams(countId: string, body: { supervisor_ids: string[]; counter_ids: string[]; aisle_ids?: string[] }) {
    return this.http.post<{ ok: boolean; aisles: number; supervisors_used: number; counters_assigned: number; aisles_without_supervisor: number; teams: AisleTeam[] }>(`${this.base}/inventory/counts/${countId}/generate-teams`, body);
  }
  inventorySetAisleTeams(countId: string, body: { teams: { aisle_id: string; supervisor_id?: string | null; counter_ids?: string[] }[] }) {
    return this.http.post<{ ok: boolean; teams: AisleTeam[] }>(`${this.base}/inventory/counts/${countId}/aisle-teams`, body);
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
  /** Conteo de pedidos por status en 1 request (reemplaza el N+1 de los chips). */
  orderCounts(opts: { customer_id?: string; from?: string; to?: string; mine?: boolean } = {}) {
    let params = new HttpParams();
    if (opts.customer_id) params = params.set('customer_id', opts.customer_id);
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.mine) params = params.set('mine', 'true');
    return this.http.get<{ counts: Record<string, number>; total: number }>(`${this.base}/orders/counts`, { params });
  }
  /** J16 — serie diaria de monto/conteo para el sparkline del KPI hero. */
  orderKpiSeries(opts: { customer_id?: string; from?: string; to?: string; mine?: boolean } = {}) {
    let params = new HttpParams();
    if (opts.customer_id) params = params.set('customer_id', opts.customer_id);
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to) params = params.set('to', opts.to);
    if (opts.mine) params = params.set('mine', 'true');
    return this.http.get<OrderKpiSeries>(`${this.base}/orders/kpi-series`, { params });
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

  // ── Ventas de vendedor (ticket OCR de la captura) ──
  vendorSalesPorCaptura(opts: { date_from?: string; date_to?: string; store_id?: string } = {}): Observable<VendorSaleCapture[]> {
    let p = new HttpParams();
    if (opts.date_from) p = p.set('date_from', opts.date_from);
    if (opts.date_to) p = p.set('date_to', opts.date_to);
    if (opts.store_id) p = p.set('store_id', opts.store_id);
    return this.http.get<VendorSaleCapture[]>(`${this.base}/vendor-sales/reports/por-captura`, { params: p });
  }

  vendorSaleLines(captureRef: string): Observable<VendorSaleLine[]> {
    const p = new HttpParams().set('capture_ref', captureRef);
    return this.http.get<VendorSaleLine[]>(`${this.base}/vendor-sales/reports/captura-lines`, { params: p });
  }

  // ── Inventario físico (Fase I) ──────────────────────────────────────
  listInventoryCounts(warehouseId?: string) {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    return this.http.get<InventoryCount[]>(`${this.base}/inventory/counts`, { params });
  }

  openInventoryCount(body: { warehouse_id: string; type?: 'full' | 'cycle'; freeze_movements?: boolean; blind_double_count?: boolean; recount_threshold_pct?: number; notes?: string }) {
    return this.http.post<InventoryCount & { expected_items: number }>(`${this.base}/inventory/counts/open`, body);
  }

  submitInventoryCount(countId: string, body: { product_id?: string; barcode?: string; quantity: number; recount?: boolean }) {
    return this.http.post<InventoryCountResult>(`${this.base}/inventory/counts/${countId}/count`, body);
  }

  inventoryCountProgress(countId: string) {
    return this.http.get<InventoryCounterProgress>(`${this.base}/inventory/counts/${countId}/count-progress`);
  }

  myCountingFolios() {
    return this.http.get<InventoryCount[]>(`${this.base}/inventory/counts/mine`);
  }

  /** Catálogo blind-safe del folio (sku/barcode/nombre/ubic., sin existencia) para pre-cache offline. */
  inventoryCounterCatalog(countId: string) {
    return this.http.get<InventoryCatalogRow[]>(`${this.base}/inventory/counts/${countId}/catalog`);
  }

  resolveInventoryProduct(barcode: string) {
    return this.http.get<ResolvedProduct>(`${this.base}/inventory/counts/resolve`, { params: new HttpParams().set('barcode', barcode) });
  }

  inventoryAssignableUsers(role: 'counter' | 'supervisor') {
    return this.http.get<AssignableUser[]>(`${this.base}/inventory/counts/assignable-users`, { params: new HttpParams().set('role', role) });
  }

  inventoryListAssignments(countId: string) {
    return this.http.get<InventoryAssignment[]>(`${this.base}/inventory/counts/${countId}/assignments`);
  }

  inventorySetAssignments(countId: string, role: 'counter' | 'supervisor', userIds: string[]) {
    return this.http.post<{ ok: boolean; role: string; count: number }>(`${this.base}/inventory/counts/${countId}/assignments`, { role, user_ids: userIds });
  }

  // Supervisor / reconciliador
  inventorySupervisorProgress(countId: string) {
    return this.http.get<InventorySupervisorProgress>(`${this.base}/inventory/counts/${countId}/progress`);
  }

  inventoryCountItems(countId: string, status?: string) {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    return this.http.get<InventoryCountItem[]>(`${this.base}/inventory/counts/${countId}/items`, { params });
  }

  inventoryComputeDiscrepancies(countId: string) {
    return this.http.post<{ status: string; resolved: number; discrepancies: number }>(`${this.base}/inventory/counts/${countId}/compute`, {});
  }

  inventoryResolveItem(countId: string, itemId: string, body: { final_qty: number; notes?: string; reason_code?: string }) {
    return this.http.post<{ ok: boolean; item_id: string; final_qty: number; variance: number; reason_code: string | null }>(`${this.base}/inventory/counts/${countId}/items/${itemId}/resolve`, body);
  }

  inventoryVarianceReasons() {
    return this.http.get<{ code: string; label: string }[]>(`${this.base}/inventory/counts/variance-reasons`);
  }

  inventoryIra(params: { warehouse_id?: string; from?: string; to?: string; tolerance_pct?: number } = {}) {
    let p = new HttpParams();
    if (params.warehouse_id) p = p.set('warehouse_id', params.warehouse_id);
    if (params.from) p = p.set('from', params.from);
    if (params.to) p = p.set('to', params.to);
    if (params.tolerance_pct != null) p = p.set('tolerance_pct', String(params.tolerance_pct));
    return this.http.get<InventoryIra>(`${this.base}/inventory/counts/ira`, { params: p });
  }

  inventoryReconcile(countId: string) {
    return this.http.post<{ status: string; folio: string; items_adjusted: number; net_delta: number }>(`${this.base}/inventory/counts/${countId}/reconcile`, {});
  }

  inventoryCancelCount(countId: string, reason?: string) {
    return this.http.post<{ status: string; folio: string }>(`${this.base}/inventory/counts/${countId}/cancel`, { reason });
  }

  // Integridad: el contador reporta que salió de la app (background/lock).
  recordInventoryInterruption(
    countId: string,
    body: { left_at: string; returned_at?: string; duration_seconds?: number; source?: string },
  ) {
    return this.http.post<{ recorded: boolean; id?: string; reason?: string }>(
      `${this.base}/inventory/counts/${countId}/interruption`, body);
  }

  inventoryInterruptions(countId: string) {
    return this.http.get<InventoryInterruptions>(`${this.base}/inventory/counts/${countId}/interruptions`);
  }

  // Fases estrictas + sesiones de jornada del contador.
  inventoryStartSession(countId: string) {
    return this.http.post<{ ok: boolean; current_pass: number; status: string }>(`${this.base}/inventory/counts/${countId}/session/start`, {});
  }

  inventoryFinishSession(countId: string) {
    return this.http.post<{ ok: boolean; pass: number }>(`${this.base}/inventory/counts/${countId}/session/finish`, {});
  }

  inventorySessions(countId: string) {
    return this.http.get<InventoryCountSession[]>(`${this.base}/inventory/counts/${countId}/sessions`);
  }

  inventoryAdvancePass(countId: string) {
    return this.http.post<{ current_pass: number; status: string; next: string }>(`${this.base}/inventory/counts/${countId}/advance-pass`, {});
  }

  // Stock muerto (analytics)
  deadStock(warehouseId?: string, limit?: number) {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    if (limit) params = params.set('limit', String(limit));
    return this.http.get<DeadStockReport>(`${this.base}/analytics/dead-stock`, { params });
  }

  // KV.5/KV.3/KV.6 — analytics de venta real Kepler
  inventoryHealth(warehouseId?: string, status?: string) {
    let params = new HttpParams();
    if (warehouseId) params = params.set('warehouse_id', warehouseId);
    if (status) params = params.set('status', status);
    return this.http.get<InventoryHealthResponse>(`${this.base}/analytics/inventory-health`, { params });
  }
  erpCustomers(search?: string, limit = 200) {
    let params = new HttpParams().set('limit', String(limit));
    if (search) params = params.set('search', search);
    return this.http.get<ErpCustomerRow[]>(`${this.base}/analytics/erp-customers`, { params });
  }
  erpCustomerProducts(code: string) {
    return this.http.get<ErpCustomerProduct[]>(`${this.base}/analytics/erp-customers/${encodeURIComponent(code)}/products`);
  }
  erpPromotions() {
    return this.http.get<ErpPromoRow[]>(`${this.base}/analytics/erp-promotions`);
  }

  // ── Fase RS — Generador Sell-Out por empresa ──
  sellOutBrands(search?: string) {
    let params = new HttpParams();
    if (search) params = params.set('search', search);
    return this.http.get<SellOutBrandRow[]>(`${this.base}/analytics/sell-out/brands`, { params });
  }

  sellOutWarehouses() {
    return this.http.get<SellOutWarehouseRow[]>(`${this.base}/analytics/sell-out/warehouses`);
  }

  // ── Fase SAL — Salidas/Ventas por Producto ──
  salidas(p: SalidasParams) {
    return this.http.get<SalidasReport>(`${this.base}/analytics/salidas`, { params: this.salidasParams(p) });
  }

  salidasDownloadXlsx(p: SalidasParams) {
    return this.http.get(`${this.base}/analytics/salidas.xlsx`, {
      params: this.salidasParams(p), responseType: 'blob', observe: 'response',
    });
  }

  private salidasParams(p: SalidasParams): HttpParams {
    let params = new HttpParams();
    if (p.from && p.to) params = params.set('from', p.from).set('to', p.to);
    else params = params.set('year', String(p.year ?? new Date().getFullYear()));
    if (p.warehouses?.length) params = params.set('warehouses', p.warehouses.join(','));
    if (p.brand_id) params = params.set('brand_id', p.brand_id);
    if (p.search) params = params.set('search', p.search);
    return params;
  }

  // ── Fase RR — Ventas por Ruta ──
  salesByRoute(p: SalesByRouteParams) {
    return this.http.get<SalesByRouteReport>(`${this.base}/analytics/sales-by-route`, { params: this.salesByRouteParams(p) });
  }

  salesByRouteDownloadXlsx(p: SalesByRouteParams) {
    return this.http.get(`${this.base}/analytics/sales-by-route.xlsx`, {
      params: this.salesByRouteParams(p), responseType: 'blob', observe: 'response',
    });
  }

  private salesByRouteParams(p: SalesByRouteParams): HttpParams {
    let params = new HttpParams().set('year', String(p.year));
    if (p.warehouses?.length) params = params.set('warehouses', p.warehouses.join(','));
    return params;
  }

  // ── Fase T — Traspasos (no es venta) ──
  transfers(p: TransfersParams) {
    return this.http.get<TransfersReport>(`${this.base}/analytics/transfers`, { params: this.transfersParams(p) });
  }

  transfersDownloadXlsx(p: TransfersParams) {
    return this.http.get(`${this.base}/analytics/transfers.xlsx`, {
      params: this.transfersParams(p), responseType: 'blob', observe: 'response',
    });
  }

  private transfersParams(p: TransfersParams): HttpParams {
    let params = new HttpParams().set('year', String(p.year));
    if (p.warehouses?.length) params = params.set('warehouses', p.warehouses.join(','));
    return params;
  }

  sellOut(opts: SellOutParams) {
    return this.http.get<SellOutReport>(`${this.base}/analytics/sell-out`, {
      params: this.sellOutParams(opts),
    });
  }

  /** Descarga XLSX/PDF vía blob (respeta el interceptor de auth). */
  sellOutDownload(opts: SellOutParams, fmt: 'xlsx' | 'pdf') {
    return this.http.get(`${this.base}/analytics/sell-out.${fmt}`, {
      params: this.sellOutParams(opts),
      responseType: 'blob',
      observe: 'response',
    });
  }

  private sellOutParams(opts: SellOutParams): HttpParams {
    let params = new HttpParams()
      .set('from', opts.from)
      .set('to', opts.to);
    if (opts.brand_id) params = params.set('brand_id', opts.brand_id);
    if (opts.group_by) params = params.set('group_by', opts.group_by);
    if (opts.channels?.length) params = params.set('channels', opts.channels.join(','));
    if (opts.warehouses?.length) params = params.set('warehouses', opts.warehouses.join(','));
    if (opts.include_zeros) params = params.set('include_zeros', 'true');
    if (opts.search?.trim()) params = params.set('search', opts.search.trim());
    return params;
  }

  // ── Fase GX v2 — Egresos contables (motor dinámico) ──
  expenses(p: ExpensesParams) {
    return this.http.get<ExpensesReport>(`${this.base}/analytics/expenses`, { params: this.expensesParams(p) });
  }
  expensesTree(p: ExpensesParams) {
    return this.http.get<ExpensesTree>(`${this.base}/analytics/expenses/tree`, { params: this.expensesParams(p) });
  }
  expenseDocuments(p: ExpensesParams) {
    return this.http.get<ExpenseDocRow[]>(`${this.base}/analytics/expenses/documents`, { params: this.expensesParams(p) });
  }
  expensesFilters() {
    return this.http.get<ExpensesFilters>(`${this.base}/analytics/expenses/filters`);
  }
  expensesSucursales() {
    return this.http.get<{ code: string; name: string | null }[]>(`${this.base}/analytics/expenses/sucursales`);
  }
  /** GX.6 — Solicitudes de gasto (XA1501) con estado + aplicada/pendiente + KPIs. */
  expenseRequests(p: ExpenseRequestsParams) {
    let params = new HttpParams();
    if (p.from) params = params.set('from', p.from);
    if (p.to) params = params.set('to', p.to);
    if (p.sucursal?.length) params = params.set('sucursal', p.sucursal.join(','));
    if (p.estado) params = params.set('estado', p.estado);
    if (p.solicitante?.trim()) params = params.set('solicitante', p.solicitante.trim());
    if (p.aplicada != null) params = params.set('aplicada', String(p.aplicada));
    if (p.search?.trim()) params = params.set('search', p.search.trim());
    return this.http.get<ExpenseRequestsReport>(`${this.base}/analytics/expenses/requests`, { params });
  }
  expenseDocument(sucursal: string, doc_tipo: string, folio: string) {
    const params = new HttpParams().set('sucursal', sucursal).set('doc_tipo', doc_tipo).set('folio', folio);
    return this.http.get<ExpenseDocumentDetail>(`${this.base}/analytics/expenses/document`, { params });
  }
  apProviders(p: { search?: string; sucursal?: string[]; limit?: number } = {}) {
    let params = new HttpParams();
    if (p.search?.trim()) params = params.set('search', p.search.trim());
    if (p.sucursal?.length) params = params.set('sucursal', p.sucursal.join(','));
    if (p.limit) params = params.set('limit', String(p.limit));
    return this.http.get<ApProvider[]>(`${this.base}/analytics/expenses/providers`, { params });
  }
  expenseFindings(p: { tipo?: string; sucursal?: string[]; limit?: number } = {}) {
    let params = new HttpParams();
    if (p.tipo) params = params.set('tipo', p.tipo);
    if (p.sucursal?.length) params = params.set('sucursal', p.sucursal.join(','));
    if (p.limit) params = params.set('limit', String(p.limit));
    return this.http.get<ExpenseFindingsReport>(`${this.base}/analytics/expenses/findings`, { params });
  }
  expenseProvider(key: string, opts: { sucursal?: string[] } = {}) {
    let params = new HttpParams().set('key', key);
    if (opts.sucursal?.length) params = params.set('sucursal', opts.sucursal.join(','));
    return this.http.get<ExpenseProvider360>(`${this.base}/analytics/expenses/provider`, { params });
  }
  private expensesParams(p: ExpensesParams): HttpParams {
    let params = new HttpParams();
    if (p.from) params = params.set('from', p.from);
    if (p.to) params = params.set('to', p.to);
    if (p.group_by) params = params.set('group_by', p.group_by);
    if (p.compare) params = params.set('compare', 'true');
    if (p.sucursal?.length) params = params.set('sucursal', p.sucursal.join(','));
    if (p.familia) params = params.set('familia', p.familia);
    if (p.doc_tipo) params = params.set('doc_tipo', p.doc_tipo);
    if (p.cuenta) params = params.set('cuenta', p.cuenta);
    if (p.cuenta_mayor) params = params.set('cuenta_mayor', p.cuenta_mayor);
    if (p.area) params = params.set('area', p.area);
    if (p.area_null) params = params.set('area_null', 'true');
    if (p.dpto) params = params.set('dpto', p.dpto);
    if (p.dpto_null) params = params.set('dpto_null', 'true');
    if (p.concepto) params = params.set('concepto', p.concepto);
    if (p.concepto_null) params = params.set('concepto_null', 'true');
    if (p.beneficiario?.trim()) params = params.set('beneficiario', p.beneficiario.trim());
    if (p.beneficiario_eq) params = params.set('beneficiario_eq', p.beneficiario_eq);
    if (p.beneficiario_null) params = params.set('beneficiario_null', 'true');
    if (p.min_importe != null) params = params.set('min_importe', String(p.min_importe));
    if (p.max_importe != null) params = params.set('max_importe', String(p.max_importe));
    return params;
  }
}

// ── Fase RS — Sell-Out ──
export interface SellOutBrandRow {
  id: string;
  nombre: string;
  code: string | null;
  products: number;
}

export interface SellOutParams {
  brand_id?: string;
  from: string;
  to: string;
  group_by?: 'branch' | 'branch_channel';
  channels?: string[];
  warehouses?: string[];
  include_zeros?: boolean;
  search?: string;
}

export interface SellOutWarehouseRow {
  code: string;
  name: string;
}

// ── Fase SAL ──
export interface SalidasParams {
  year?: number;
  from?: string;
  to?: string;
  warehouses?: string[];
  brand_id?: string;
  search?: string;
}

export interface SalidasRow {
  warehouse_code: string;
  warehouse_name: string;
  product_id: string;
  sku: string;
  nombre: string;
  uxc: number | null;
  supplier: string | null;
  brand: string | null;
  categoria: string | null;
  rotation_tier: string | null;
  costo_civa: number | null;
  costo_caja: number | null;
  exist_paq: number;
  exist_cja: number;
  costo_existencia: number;
  monthly: Record<string, { venta: number; costo: number }>;
  venta_total: number;
  costo_total: number;
  venta_cajas: number;
  dias_cobertura: number | null;
  venta_prev: number | null;
  venta_delta_pct: number | null;
}

export interface SalidasReport {
  mode: 'year' | 'range';
  year?: number;
  from?: string;
  to?: string;
  dias_periodo: number;
  has_trend: boolean;
  months: string[];
  rows: SalidasRow[];
  generated_at: string;
}

// ── Fase RR — Ventas por Ruta ──
export interface SalesByRouteParams {
  year: number;
  warehouses?: string[];
}

export interface SalesByRouteCell {
  revenue: number;
  units: number;
  tickets: number;
}

export interface SalesByRouteRow {
  warehouse_code: string;
  warehouse_name: string;
  route_code: string;
  route_no: string;
  label: string;
  monthly: Record<string, SalesByRouteCell>;
  revenue_total: number;
  units_total: number;
  tickets_total: number;
  share_pct: number;
}

export interface SalesByRouteReport {
  year: number;
  months: string[];
  rows: SalesByRouteRow[];
  totals: SalesByRouteCell;
  monthly_totals: Record<string, SalesByRouteCell>;
  generated_at: string;
}

// ── Fase T — Traspasos (no es venta) ──
export interface TransfersParams {
  year: number;
  warehouses?: string[];
}

export interface TransfersCell {
  value: number;
  units: number;
  docs: number;
}

export interface TransfersRow {
  warehouse_code: string;
  warehouse_name: string;
  kind: string;
  kind_label: string;
  dest_label: string;
  monthly: Record<string, TransfersCell>;
  value_total: number;
  units_total: number;
  docs_total: number;
  share_pct: number;
}

export interface TransfersReport {
  year: number;
  months: string[];
  rows: TransfersRow[];
  totals: TransfersCell;
  monthly_totals: Record<string, TransfersCell>;
  by_kind: { kind: string; kind_label: string; value: number; share_pct: number }[];
  generated_at: string;
}

export interface SellOutColumn {
  key: string;
  branch_code: string;
  branch_name: string;
  channel?: string;
  channel_label?: string;
}

export interface SellOutCell {
  cajas: number;
  monto: number;
}

export interface SellOutRow {
  product_id: string;
  sku: string;
  nombre: string;
  uxc: number | null;
  cells: Record<string, SellOutCell>;
  total: SellOutCell;
}

export interface SellOutReport {
  brand: { id: string | null; nombre: string; code: string | null };
  period: { from: string; to: string };
  group_by: 'branch' | 'branch_channel';
  row_dim: 'brand' | 'product';
  columns: SellOutColumn[];
  rows: SellOutRow[];
  column_totals: Record<string, SellOutCell>;
  grand_total: SellOutCell;
  coverage: { branches_with_data: string[]; branches_missing: string[]; note: string };
  generated_at: string;
}

export interface InventoryHealthRow {
  warehouse_code: string;
  sku: string;
  product_name: string;
  brand_name: string | null;
  on_hand: number;
  avg_daily_units: number;
  days_cover: number | null;
  status: string;
}
export interface InventoryHealthResponse {
  summary: { status: string; n: number }[];
  items: InventoryHealthRow[];
}
export interface ErpCustomerRow {
  erp_code: string;
  name: string;
  rfc: string | null;
  city: string | null;
  last_purchase: string | null;
  rev_180d: number;
  products: number;
}
export interface ErpCustomerProduct {
  sku: string;
  product_name: string;
  units_90d: number;
  revenue_90d: number;
  units_180d: number;
  revenue_180d: number;
  last_purchase_date: string | null;
}
export interface ErpPromoRow {
  sku: string;
  product_name: string;
  promo_type: string;
  threshold: number | null;
  benefit: number | null;
  free_product_name: string | null;
  valid_from: string | null;
  valid_to: string | null;
  warehouse_code: string | null;
}

export interface DeadStockItem {
  warehouse_code: string;
  warehouse_name: string;
  sku: string;
  product_name: string;
  brand_name: string | null;
  rotation_tier: string | null;
  unit_sale: string | null;
  quantity: number;
  cost_base: number;
  capital_parado: number;
}

export interface DeadStockReport {
  warehouse_id: string | null;
  total_skus: number;
  total_capital_parado: number;
  by_warehouse: { warehouse_code: string; warehouse_name: string; skus: number; capital_parado: number | string }[];
  items: DeadStockItem[];
}

export interface InventoryCount {
  id: string;
  folio: string;
  warehouse_id: string;
  warehouse_code?: string;
  warehouse_name?: string;
  type: 'full' | 'cycle';
  status: 'open' | 'counting' | 'review' | 'ready_to_reconcile' | 'reconciled' | 'cancelled';
  freeze_movements?: boolean;
  blind_double_count?: boolean;
  started_at?: string;
  closed_at?: string;
  created_at?: string;
}

export interface AssignableUser {
  id: string;
  username: string;
  nombre: string | null;
  role_name: string;
}

export interface InventoryCatalogRow {
  product_id: string | null;
  sku: string | null;
  barcode: string | null;
  product_name: string | null;
  location: string | null;
}

export interface InventoryAssignment {
  user_id: string;
  assignment_role: 'counter' | 'supervisor';
  username: string | null;
  nombre: string | null;
}

export interface InventoryCounterProgress {
  folio: string;
  status: string;
  current_pass: number;
  total: number;
  counted: number;
  remaining: number;
  mine: number;
}

export interface InventoryCountSession {
  id: string;
  user_id: string;
  username: string | null;
  pass: number;
  started_at: string;
  finished_at: string | null;
  status: 'active' | 'finished';
  items_counted: number;
  units_counted: number;
  interruptions: number;
  interrupt_seconds: number;
}

export interface ResolvedProduct {
  product_id: string;
  sku: string | null;
  product_name: string | null;
  brand_name: string | null;
  location: string | null;
  unit_sale: string | null;
}

export interface InventoryCountResult {
  ok: boolean;
  item_id: string;
  slot: string;
  product_id: string;
  sku: string | null;
  product_name: string | null;
  location: string | null;
  quantity: number;
}

export interface InventorySupervisorProgress {
  folio: string;
  status: string;
  current_pass: number;
  blind_double_count: boolean;
  coverage_pct: number;
  pass_coverage_pct: number;
  total: number;
  counted_once: number;
  counted_pass: number;
  uncounted: number;
  discrepancies: number;
  resolved: number;
  value_at_variance: number | string;
  by_counter: { user_id: string; counts: number; discrepancies: number }[];
}

export interface InventoryInterruptionEvent {
  id: string;
  user_id: string;
  username: string | null;
  left_at: string;
  returned_at: string | null;
  duration_seconds: number | null;
  source: 'visibility' | 'appstate';
}

export interface InventoryInterruptions {
  events: InventoryInterruptionEvent[];
  by_user: {
    user_id: string;
    username: string | null;
    count: number;
    total_seconds: number;
    max_seconds: number;
  }[];
}

export interface InventoryCountItem {
  id: string;
  product_id: string;
  sku: string | null;
  product_name: string | null;
  brand_name: string | null;
  location: string | null;
  expected_qty: number | string;
  count_1: number | string | null;
  count_2: number | string | null;
  count_3: number | string | null;
  final_qty: number | string | null;
  variance: number | string | null;
  status: 'pending' | 'counted' | 'discrepancy' | 'resolved';
  notes: string | null;
  reason_code: string | null;
  cost_base: number | string | null;
}

export interface InventoryIra {
  tolerance_pct: number;
  folios: number;
  total_items: number;
  accurate_items: number;
  ira_pct: number | null;
  value_accuracy_pct: number | null;
  net_variance_value: number;
  abs_variance_value: number;
  expected_value: number;
  by_reason: { reason_code: string; items: number; units: number; value: number }[];
  recent_folios: {
    count_id: string; folio: string; warehouse_id: string; warehouse_code: string | null;
    reconciled_at: string; items: number; accurate: number; ira_pct: number | null; net_variance_value: number;
  }[];
}

export interface RouteTicketAdmin {
  id: string;
  ticket_type: 'venta' | 'carga' | 'combustible';
  route_code: string;
  ticket_date: string;
  ticket_time: string | null; // hora impresa HH:MM[:SS]
  total: number | null;
  corte_number: string | null;
  reference: string | null;
  folio: string | null;
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

export interface VendorSaleCapture {
  capture_ref: string;
  store_id: string;
  store_name?: string | null;
  route_id?: string | null;
  route_name?: string | null;
  vendor_user_id: string;
  vendor_name?: string | null;
  vendor_username?: string | null;
  sale_date: string;
  lineas: number | string;
  unidades: number | string;
  ticket_photo_url?: string | null;
  daily_capture_id?: string | null;
  created_at?: string;
}

export interface VendorSaleLine {
  id: string;
  sku: string;
  product_name?: string | null;
  quantity: number | string;
  confidence?: string | null;
  product_id?: string | null;
}

// ── Fase GX v2 — Egresos contables ──
export type ExpenseGroupBy = 'cuenta' | 'cuenta_mayor' | 'beneficiario' | 'sucursal' | 'doc_tipo' | 'area' | 'dpto' | 'mes';
export interface ExpensesParams {
  from?: string;
  to?: string;
  group_by?: ExpenseGroupBy;
  compare?: boolean;
  sucursal?: string[];
  familia?: '5' | '6';
  doc_tipo?: string;
  cuenta?: string;
  cuenta_mayor?: string;
  area?: string;
  area_null?: boolean;
  dpto?: string;
  dpto_null?: boolean;
  concepto?: string;
  concepto_null?: boolean;
  beneficiario?: string;
  beneficiario_eq?: string;
  beneficiario_null?: boolean;
  min_importe?: number;
  max_importe?: number;
}
export interface ExpenseFamiliaRow { familia: string; label: string; total: number; movs: number; }
export interface ExpenseRow {
  key: string;
  label: string;
  familia: string | null;
  total: number;
  movs: number;
  share_pct: number;
  prev_total: number | null;
  delta_pct: number | null;
}
export interface ExpenseSeriesPoint { mes: string; total: number; compras: number; gastos: number; }
export interface ExpensesReport {
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  group_by: string;
  total: number;
  movimientos: number;
  by_familia: ExpenseFamiliaRow[];
  rows: ExpenseRow[];
  series: ExpenseSeriesPoint[];
}
export interface ExpenseTreeNode {
  key: string;
  label: string;
  level: string;
  total: number;
  movs: number;
  share_pct: number;
  children?: ExpenseTreeNode[];
}
export interface ExpensesTree { from: string; to: string; total: number; tree: ExpenseTreeNode[]; }
export interface ExpenseDocRow {
  fecha: string;
  sucursal: string;
  sucursal_nombre: string | null;
  doc_tipo: string;
  doc_folio: string;
  beneficiario: string | null;
  beneficiario_doc: string | null;
  cuenta: string;
  cuenta_nombre: string | null;
  concepto_nombre: string | null;
  comentario: string | null;
  area: string | null;
  importe: number;
}
export interface ExpensesFilters {
  doc_tipos: string[];
  areas: string[];
  mayores: { code: string; nombre: string | null }[];
  dptos: { code: string; nombre: string | null }[];
  conceptos: string[];
}
// GX v3 — drill al documento fuente
export interface ExpenseDocHeader {
  sucursal: string;
  sucursal_nombre: string | null;
  doc_tipo: string;
  doc_folio: string;
  fecha: string | null;
  fecha_doc: string | null;
  beneficiario: string | null;
  rfc: string | null;
  concepto: string | null;
  area: string | null;
  importe: number;
  iva: number;
  usuario: string | null;
  clase: string | null;
  solicitud_tipo: string | null;
  solicitud_folio: string | null;
}
export interface ExpensePosting {
  linea: number;
  cuenta: string;
  cuenta_nombre: string | null;
  cuenta_mayor: string | null;
  familia: string | null;
  concepto_nombre: string | null;
  comentario: string | null;
  beneficiario_doc: string | null;
  importe: number;
}
export interface ExpenseProductLine {
  linea: number;
  sku: string | null;
  producto: string | null;
  cantidad: number | null;
  presentacion: string | null;
  costo_unitario: number | null;
  importe: number;
}
// GX.4.3b — cadena de aprovisionamiento (orden→recepción→factura→pago); null hasta que exista el feed
export interface ExpenseDocChain {
  orden_folio: string | null;
  orden_fecha: string | null;
  recepcion_folio: string | null;
  recepcion_fecha: string | null;
  factura_folio: string | null;
  factura_fecha: string | null;
  pago_folio: string | null;
  pago_fecha: string | null;
  lead_days: number | null;
  pago_days: number | null;
}
export interface ExpenseRequestsParams {
  from?: string; to?: string; sucursal?: string[]; estado?: string;
  solicitante?: string; aplicada?: boolean; search?: string;
}
export interface ExpenseRequestRow {
  folio: string;
  sucursal: string;
  sucursal_nombre: string | null;
  fecha: string | null;
  importe: number;
  solicitante: string | null;
  beneficiario: string | null;
  concepto: string | null;
  estado: string | null;
  aplicada: boolean;
  gasto_folio: string | null;
  gasto_fecha: string | null;
  lead_days: number | null;
}
export interface ExpenseRequestsReport {
  kpis: { total: number; importe: number; pendientes: number; pendientes_importe: number; aplicadas: number };
  rows: ExpenseRequestRow[];
}
/** GX.6 — solicitud (XA1501) que originó un gasto (XA1001). */
export interface ExpenseRequest {
  folio: string;
  fecha: string | null;
  importe: number;
  solicitante: string | null;
  beneficiario: string | null;
  concepto: string | null;
  estado: string | null;
  usuario: string | null;
  aplicada: boolean;
  lead_days: number | null;
}
export interface ExpenseDocumentDetail {
  header: ExpenseDocHeader | null;
  postings: ExpensePosting[];
  lines: ExpenseProductLine[];
  chain?: ExpenseDocChain | null;
  request?: ExpenseRequest | null;
}
// GX v3 — proveedores (201) + hallazgos
export interface ApProvider {
  proveedor: string;
  compra_12m: number;
  pagos_12m: number;
  saldo: number;
  num_facturas: number;
  ultima_compra: string | null;
  dpo_dias: number | null;
  share_pct: number;
}
export interface ExpenseFinding {
  fecha: string | null;
  sucursal: string;
  sucursal_nombre: string | null;
  doc_tipo: string;
  doc_folio: string;
  beneficiario: string | null;
  cuenta: string | null;
  importe: number;
  nota: string | null;
}
export interface ExpenseFindingsReport {
  summary: { tipo: string; num: number; total: number }[];
  tipo: string | null;
  rows: ExpenseFinding[];
}
// GX.4.2 — Proveedor 360
export interface ExpenseProviderSummary {
  proveedor: string;
  compra_12m: number;
  pagos_12m: number;
  saldo: number;
  num_facturas: number;
  dpo_dias: number | null;
  ultima_compra: string | null;
}
export interface ExpenseProviderProduct {
  sku: string | null;
  producto: string | null;
  cantidad: number | null;
  importe: number;
  docs: number;
}
export interface ExpenseProvider360 {
  summary: ExpenseProviderSummary | null;
  top_products: ExpenseProviderProduct[];
}
