import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map, of, switchMap, forkJoin } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  PortalService,
  PriceRow,
  Order,
  OrderLine,
} from '../portal/portal.service';
import { AuthService } from '../../core/services/auth.service';

export interface VendorCustomer {
  id: string;
  code: string;
  name: string;
  legal_name?: string;
  phone?: string;
  whatsapp?: string | null;
  sales_route?: string | null;
  visit_sequence?: number | null;
  credit_limit: number;
  default_price_list_id?: string | null;
  active: boolean;
}

/** Estado de carga de una línea (lo que devuelve el backend). */
export interface CargaLoadStatusRow {
  order_id: string;
  product_id: string;
  status: 'loaded' | 'not_loaded';
  reason: string | null;
  quantity: number | null;
  product_name: string | null;
  delivery_date: string | null;
}
/** Payload para marcar una línea de carga. status='pending' borra la fila. */
export interface SetCargaLoadStatus {
  order_id: string;
  product_id: string;
  status: 'loaded' | 'not_loaded' | 'pending';
  reason?: string | null;
  quantity?: number | null;
  product_name?: string | null;
  delivery_date?: string | null;
}

/** Pedido pendiente del cliente, embebido en el feed del home. */
export interface HomePendingOrder {
  id: string;
  code: string;
  status: string;
  total: number | string;
  requested_delivery_date?: string | null;
  created_at: string;
  is_preventa?: boolean;
}

/**
 * Cliente de la cartera anotado para el home "Mi ruta": cobertura + actividad
 * del día + pedidos pendientes, de un solo fetch.
 */
export interface HomeCustomer {
  id: string;
  code: string;
  name: string;
  visit_sequence?: number | null;
  sales_route?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  visited_today: boolean;
  last_visit_at?: string | null;
  ordered_today: boolean;
  pending_count: number;
  pending_total: number;
  has_preventa_pending: boolean;
  pending_orders: HomePendingOrder[];
}

/**
 * Cliente de la cartera anotado con su cobertura del día (apartado "Por visitar").
 */
export interface CoverageCustomer {
  id: string;
  code: string;
  name: string;
  visit_sequence?: number | null;
  sales_route?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  visited_today: boolean;
  last_visit_at?: string | null;
}

/** Cliente de la cartera detectado por cercanía GPS (ordenado por distancia). */
export interface NearbyCustomer {
  id: string;
  code: string;
  name: string;
  sales_route?: string | null;
  visit_sequence?: number | null;
  phone?: string | null;
  whatsapp?: string | null;
  latitude: number | string;
  longitude: number | string;
  distance_m: number;
}

/** Otro cliente cuyas coords colisionan con las que se intentan registrar. */
export interface LocationConflict {
  customer_id: string;
  code: string;
  name: string;
  distance_m: number;
}

/** Resultado de setear/backfillear coords (con guard anti-traslape). */
export interface SetLocationResult {
  location_set: boolean;
  conflict?: LocationConflict;
  min_separation_m?: number;
  customer_id?: string;
  latitude?: number;
  longitude?: number;
}

/** Sugerencia de Thot (motor de inteligencia) para take-order. */
export interface ThotSuggestion {
  product_id: string;
  product_name: string;
  price: number;
  tax_rate: number;
  min_qty: number;
  rotation_tier: string | null;
  margin_pct: number | null;
  aff_lift: number;
  zona_index: number;
  score: number;
  reason: 'affinity' | 'zona' | 'rotacion' | 'margen' | 'demanda';
  reason_label: string;
}

/** TC-V — chat del vendedor. */
export interface VendorThotToolTrace { name: string; input: any; result: any; }
export interface VendorThotChatResult {
  answer: string;
  source: 'llm' | 'no_api_key' | 'error';
  tools_used: VendorThotToolTrace[];
  iterations: number;
  log_id?: string | null;
}

/** VQ: producto que el cliente compra habitualmente (agregado de su historial). */
export interface FrequentProduct {
  product_id: string;
  product_name: string | null;
  sku: string | null;
  brand_name: string | null;
  order_count: number;
  total_qty: number;
  avg_qty: number;
  last_ordered_at: string;
}

/** VQ-voz: producto sugerido por la IA a partir del dictado/texto libre. */
export interface AiSuggestion {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  qty: number;
  unit_price: number;
  min_qty: number;
  reason: string;
}

/** Cliente due-for-reorder según el motor de inteligencia (Fase M). */
export interface NbaDue {
  customer_id: string;
  code: string | null;
  name: string | null;
  next_order_estimate: string | null;
  cadence_days: number | null;
  days_overdue: number;
  urgency: 'low' | 'medium' | 'high';
}

/**
 * Order enriquecida que devuelve el listado de pedidos para el vendedor:
 * incluye `is_preventa` (originado por el cliente vía Portal B2B) + datos
 * desnormalizados para pintar la lista sin un fetch extra por pedido.
 */
export interface VendorOrder extends Order {
  is_preventa?: boolean;
  customer_name?: string | null;
  user_id?: string | null;
  user_username?: string | null;
  route_name?: string | null;
  folio?: string;
  requested_delivery_date?: string | null;
}

// ─── Cierre de ruta ───
export type RouteTicketType = 'venta' | 'carga' | 'combustible';

export interface RouteTicketFields {
  route_code: string | null;
  ticket_date: string | null;
  ticket_time: string | null; // hora impresa HH:MM
  total: number | null;
  corte_number: string | null;
  reference: string | null;
  liters: number | null;
  folio: string | null; // solo carga
}

export interface RouteTicketLinePreview {
  raw: string;
  normalized: string;
  quantity: number;
  product_id: string | null;
  product_name: string | null;
  confidence: string;
}

export interface ProcesarRouteTicketResult {
  ticket_type: RouteTicketType;
  cloudinary_public_id: string;
  photo_url: string;
  photo_preview_url: string;
  fields: RouteTicketFields;
  /** Resolución de la ruta detectada contra el catálogo de la zona del vendedor. */
  route_matched: boolean;
  route_value: string | null; // nombre canónico, ej. "RUTA 321"
  /** Solo carga: el folio ya existe en el historial (no reusable) → bloquea guardado. */
  folio_in_use?: boolean;
  lines?: RouteTicketLinePreview[]; // solo carga
}

export interface RouteTicket {
  id: string;
  ticket_type: RouteTicketType;
  route_code: string;
  ticket_date: string;
  total: number | null;
  corte_number: string | null;
  reference: string | null;
  liters: number | null;
  folio?: string | null; // solo carga
  photo_url?: string | null;
  created_at: string;
}

/**
 * Service del modo vendedor (colaborador). Reusa PortalService para
 * operaciones de carrito/orden — un vendedor en campo es esencialmente un
 * cliente con permisos extendidos: puede tomar pedido para CUALQUIER customer
 * (no solo el suyo).
 *
 * Diferencias vs portal:
 *  - El vendedor NO está linkeado a un customer (customer_id en su user es null).
 *  - Debe seleccionar un customer del listado del tenant antes de tomar pedido.
 *  - El draft creado lleva customer_id del cliente seleccionado + user_id del vendedor.
 *
 * Offline real (Dexie sync queue para pedidos sin conexión) está deferred —
 * por ahora todas las operaciones requieren conexión.
 */
/** Parada a domicilio del repartidor (Fase LM). */
export interface RiderDelivery {
  recipient_id: string;
  status: string;
  customer_name: string;
  delivery_address: { street?: string; references?: string; recipient_name?: string; phone?: string; lat?: number; lng?: number } | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  incident_type?: string | null;
  shipment_folio?: string | null;
  shipment_id?: string | null;
  shipment_notes?: string | null;
  order_id?: string | null;
  order_code?: string | null;
  total?: number | string | null;
  balance_due?: number | string | null;
  payment_method?: string | null;
}

export type DeliveryOutcome =
  | 'delivered' | 'not_located' | 'wrong_address' | 'customer_rejected' | 'missing_product' | 'other';

/** Payload para cerrar la parada. */
export interface RecordDeliveryOutcome {
  outcome: DeliveryOutcome;
  delivered_to?: string;
  signature_url?: string;
  proof_photo_url?: string;
  whatsapp_confirmed?: boolean;
  gps_lat?: number;
  gps_lng?: number;
  payment?: { order_id: string; method: 'cash' | 'transfer' | 'card' | 'prepaid'; amount: number; cash_received?: number; reference?: string };
  incident_notes?: string;
  attempted_at?: string;
}

@Injectable({ providedIn: 'root' })
export class VendorService {
  private readonly http = inject(HttpClient);
  private readonly portal = inject(PortalService);
  private readonly auth = inject(AuthService);
  private readonly base = environment.apiUrl + '/commercial';
  private readonly apiRoot = environment.apiUrl;

  /** sub del JWT del vendedor logueado. Lo usamos para scoping de drafts / "Mi día". */
  private get vendorUserId(): string | null {
    return this.auth.user()?.sub || null;
  }

  // ─── Fase LM — Entregas a domicilio (repartidor) ───

  /** Paradas a domicilio asignadas al repartidor. */
  myDeliveries(): Observable<RiderDelivery[]> {
    return this.http.get<RiderDelivery[]>(`${this.apiRoot}/logistics/home-dispatch/my-deliveries`);
  }

  /** Cierra la parada: entrega (evidencia + cobro) o incidencia. */
  recordDeliveryOutcome(recipientId: string, dto: RecordDeliveryOutcome): Observable<any> {
    return this.http.post(`${this.base}/home-delivery/recipients/${recipientId}/outcome`, dto);
  }

  // ─── Customers ───

  listCustomers(opts: { search?: string; pageSize?: number } = {}): Observable<{
    data: VendorCustomer[];
    total: number;
  }> {
    let p = new HttpParams().set('pageSize', String(opts.pageSize ?? 50));
    if (opts.search) p = p.set('search', opts.search);
    return this.http.get<{ data: VendorCustomer[]; total: number }>(
      `${this.base}/customers`,
      { params: p },
    );
  }

  getCustomer(id: string): Observable<VendorCustomer> {
    return this.http.get<VendorCustomer>(`${this.base}/customers/${id}`);
  }

  /**
   * Alta rápida de cliente desde la app (campo). El backend genera el code y
   * asigna la price list default → el cliente queda pedible de inmediato.
   * Gateado por COMMERCIAL_ORDERS_CREAR (el vendedor ya lo tiene).
   */
  createCustomer(dto: {
    name: string;
    phone?: string;
    whatsapp?: string;
    rfc?: string;
    legal_name?: string;
    sales_route?: string;
    notes?: string;
    latitude?: number;
    longitude?: number;
  }): Observable<VendorCustomer> {
    return this.http.post<VendorCustomer>(
      `${this.base}/vendor-routes/customers`,
      dto,
    );
  }

  /**
   * Cartera del vendedor: clientes de las rutas de venta asignadas a este user
   * (commercial.vendor_sales_routes), ya ordenados por `visit_sequence` desde el
   * backend. Es la base de "Clientes por ver" / "Pedido nuevo".
   */
  myCartera(opts: { search?: string; pageSize?: number } = {}): Observable<{
    data: VendorCustomer[];
    total: number;
  }> {
    let p = new HttpParams()
      .set('mine', 'true')
      .set('pageSize', String(opts.pageSize ?? 200));
    if (opts.search) p = p.set('search', opts.search);
    return this.http.get<{ data: VendorCustomer[]; total: number }>(
      `${this.base}/customers`,
      { params: p },
    );
  }

  // ─── Catalog scoped al customer ───

  /**
   * Devuelve productos con SU precio para el customer dado. Resuelve la
   * price list (customer default → tenant default). Devuelve [] si no hay
   * price list aplicable.
   */
  /**
   * Devuelve productos con SU precio + stock disponible para el customer y warehouse
   * dados. J.6.7: si pasás `warehouseId`, cada item incluye `stock_available`.
   *
   * Recibe el customer YA resuelto (no lo re-fetchea): el caller ya lo tiene del
   * forkJoin de carga, así evitamos pedir `getCustomer` dos veces.
   */
  catalogForCustomer(
    customer: VendorCustomer,
    warehouseId?: string,
  ): Observable<{ priceListId: string; prices: PriceRow[] }> {
    return this.portal.listPriceLists().pipe(
      switchMap((priceLists) => {
        const list =
          (customer.default_price_list_id &&
            priceLists.find((p: any) => p.id === customer.default_price_list_id)) ||
          priceLists.find((p: any) => p.is_default);
        if (!list) return of({ priceListId: '', prices: [] as PriceRow[] });
        // priced_only: el catálogo del vendedor = solo lo pedible (con precio),
        // completo. Sin esto el backend capa a 500 productos. Devolvemos el
        // priceListId para cachearlo (dedup del catálogo offline por lista).
        return this.portal
          .listPricesForList(list.id, warehouseId, { pricedOnly: true })
          .pipe(map((prices) => ({ priceListId: list.id, prices })));
      }),
    );
  }

  // ─── Take order (find-or-create draft scoped al customer) ───

  /**
   * Obtiene draft activo DE ESTE vendedor para ESTE customer, si existe.
   * Scope obligatorio por `user_id` — sin esto, dos vendedores pueden tomar
   * drafts uno del otro al elegir el mismo cliente (bug encontrado en
   * audit 2026-06-01).
   */
  draftForCustomer(customerId: string): Observable<Order | null> {
    const userId = this.vendorUserId;
    if (!userId) return of(null);
    const params = new HttpParams()
      .set('status', 'draft')
      .set('customer_id', customerId)
      .set('user_id', userId)
      .set('pageSize', '5');
    return this.http
      .get<{ data: Order[] }>(`${this.base}/orders`, { params })
      .pipe(map((r) => (r.data?.[0] || null) as Order | null));
  }

  /** Crea un draft nuevo (sin chequear si ya hay uno). Para cuando el caller ya
   *  sabe que no existe draft — evita el GET extra de `draftForCustomer`. */
  createDraftForCustomer(
    customerId: string,
    warehouseId: string,
    deliveryType: 'route' | 'long_trip' = 'route',
  ): Observable<Order> {
    return this.http.post<Order>(`${this.base}/orders`, {
      customer_id: customerId,
      warehouse_id: warehouseId,
      delivery_type: deliveryType,
    });
  }

  ensureDraftForCustomer(
    customerId: string,
    warehouseId: string,
    deliveryType: 'route' | 'long_trip' = 'route',
  ): Observable<Order> {
    return this.draftForCustomer(customerId).pipe(
      switchMap((existing) =>
        existing ? of(existing) : this.createDraftForCustomer(customerId, warehouseId, deliveryType),
      ),
    );
  }

  addLine(orderId: string, productId: string, quantity: number): Observable<OrderLine> {
    return this.portal.addLine(orderId, productId, quantity);
  }

  updateLine(orderId: string, lineId: string, quantity: number): Observable<OrderLine> {
    return this.portal.updateLine(orderId, lineId, quantity);
  }

  removeLine(orderId: string, lineId: string) {
    return this.portal.removeLine(orderId, lineId);
  }

  confirm(orderId: string) {
    return this.portal.confirm(orderId);
  }

  /** pending_approval → confirmed. El vendedor aprueba un pedido de preventa. */
  approve(orderId: string): Observable<VendorOrder> {
    return this.http.post<VendorOrder>(`${this.base}/orders/${orderId}/approve`, {});
  }

  /**
   * Tomar pedido en campo (preventa): draft → confirmed en 1 request atómico e
   * idempotente. Reemplaza el encadenado updateDraftHeader→confirm→approve, que
   * podía quedar a medias y dejar el reintento atascado en "solo desde draft".
   */
  placeOrder(
    orderId: string,
    dto: { requested_delivery_date?: string; notes?: string; delivery_type?: 'route' | 'long_trip' } = {},
  ): Observable<VendorOrder> {
    return this.http.post<VendorOrder>(`${this.base}/orders/${orderId}/place`, dto);
  }

  /** confirmed → fulfilled. El vendedor marca el pedido como entregado en campo. */
  fulfill(orderId: string): Observable<VendorOrder> {
    return this.http.post<VendorOrder>(`${this.base}/orders/${orderId}/fulfill`, {});
  }

  cancel(orderId: string, reason?: string) {
    return this.portal.cancel(orderId, reason);
  }

  orderById(id: string) {
    return this.portal.orderById(id);
  }

  /**
   * Pedidos pendientes (pending_approval/confirmed) de UN cliente — para avisar
   * en take-order y no duplicar (preventa del portal o pedido de campo ya vivo).
   */
  pendingForCustomer(customerId: string): Observable<VendorOrder[]> {
    const params = new HttpParams()
      .set('customer_id', customerId)
      .set('statuses', 'pending_approval,confirmed')
      .set('pageSize', '10');
    return this.http
      .get<{ data: VendorOrder[] }>(`${this.base}/orders`, { params })
      .pipe(map((r) => r.data || []));
  }

  /**
   * Pedidos "por entregar" de la cartera del vendedor: preventa (creada por el
   * cliente) + de campo, en estados pending_approval y confirmed. Es la base del
   * apartado "Por entregar". Ordenados por fecha desc desde el backend.
   */
  pendingDeliveries(): Observable<VendorOrder[]> {
    const params = new HttpParams()
      .set('mine', 'true')
      .set('statuses', 'pending_approval,confirmed')
      .set('pageSize', '200');
    return this.http
      .get<{ data: VendorOrder[] }>(`${this.base}/orders`, { params })
      .pipe(map((r) => r.data || []));
  }

  /**
   * Pedidos a CARGAR: confirmados de la cartera del vendedor. El filtro por fecha
   * (próximo día hábil sáb→lun + los sin fecha) lo aplica el componente. Solo
   * cabeceras; las líneas se piden con `orderById` para agregar productos.
   */
  cargaOrders(): Observable<VendorOrder[]> {
    const params = new HttpParams()
      .set('mine', 'true')
      .set('statuses', 'confirmed')
      .set('pageSize', '300');
    return this.http
      .get<{ data: VendorOrder[] }>(`${this.base}/orders`, { params })
      .pipe(map((r) => r.data || []));
  }

  // ─── Carga: checklist 'sí cargamos / no cargamos' (registrado en backend) ───

  /** Estados de carga (loaded/not_loaded) de las líneas de los pedidos dados. */
  cargaLoadStatuses(orderIds: string[]): Observable<CargaLoadStatusRow[]> {
    if (!orderIds.length) return of([]);
    const params = new HttpParams().set('order_ids', orderIds.join(','));
    return this.http.get<CargaLoadStatusRow[]>(`${this.base}/carga/load-status`, { params });
  }

  /** Marca una línea: loaded / not_loaded (+motivo) / pending (borra la fila). */
  setCargaLoadStatus(dto: SetCargaLoadStatus): Observable<unknown> {
    return this.http.put(`${this.base}/carga/load-status`, dto);
  }

  /** Marca varias líneas de una (toggle por pedido o por producto). */
  setCargaLoadStatusBulk(items: SetCargaLoadStatus[]): Observable<unknown> {
    return this.http.post(`${this.base}/carga/load-status/bulk`, { items });
  }

  // ─── Home "Mi ruta": feed unificado + autoventa ───

  /** Feed del home "Mi ruta": cartera anotada (cobertura + actividad + pendientes) de un fetch. */
  home(): Observable<HomeCustomer[]> {
    return this.http.get<HomeCustomer[]>(`${this.base}/vendor-routes/home`);
  }

  /**
   * Clientes due-for-reorder hoy (motor de inteligencia, Fase M). Tenant-wide;
   * el home lo intersecta con la cartera. Best-effort: si el endpoint no está
   * disponible (migración sin aplicar), el caller cae a [] sin romper la ruta.
   */
  nbaDue(): Observable<NbaDue[]> {
    return this.http.get<NbaDue[]>(`${this.base}/intelligence/nba`);
  }

  /**
   * Thot — qué ofrecerle a este cliente (producto-first: rotación·margen·afinidad·zona).
   * Si pasás `cartProductIds`, las sugerencias se vuelven cart-aware ("completá la canasta").
   * Best-effort: si el motor/feature store no está, el caller cae a su lista local.
   */
  thotSuggest(customerId: string, cartProductIds: string[] = [], limit = 40): Observable<ThotSuggestion[]> {
    let p = new HttpParams().set('limit', String(limit));
    if (cartProductIds.length) p = p.set('cart', cartProductIds.join(','));
    return this.http.get<ThotSuggestion[]>(
      `${this.base}/intelligence/thot/suggest/${customerId}`,
      { params: p },
    );
  }

  /** TC-V — Copiloto conversacional del vendedor (scoped a su cartera, stock PH). */
  thotChat(history: { role: 'user' | 'assistant'; content: string }[], message: string): Observable<VendorThotChatResult> {
    return this.http.post<VendorThotChatResult>(`${this.base}/intelligence/vendor/thot/chat`, { history, message });
  }
  thotFeedback(logId: string, vote: number): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/intelligence/thot/feedback`, { log_id: logId, vote });
  }

  /**
   * VQ: productos habituales del cliente (order pad). Best-effort: si el endpoint
   * no está (api sin desplegar), el caller cae a [] y muestra solo sugeridos.
   */
  frequentProducts(customerId: string, days = 120, limit = 50): Observable<FrequentProduct[]> {
    const p = new HttpParams().set('days', String(days)).set('limit', String(limit));
    return this.http.get<FrequentProduct[]>(`${this.base}/orders/frequent/${customerId}`, { params: p });
  }

  /**
   * VQ-voz: convierte texto libre / dictado ("5 cajas de paleta payaso, 3 de
   * bubaloo") en productos + cantidades del catálogo del cliente (Claude Haiku,
   * con fallback heurístico server-side). customerId = el cliente visitado.
   */
  aiOrderSuggest(
    message: string,
    customerId: string,
  ): Observable<{ assistant_message: string; suggestions: AiSuggestion[] }> {
    return this.http.post<{ assistant_message: string; suggestions: AiSuggestion[] }>(
      `${this.base}/ai-order/suggest`,
      { message, customer_id: customerId },
    );
  }

  /** VQ: reemplaza TODAS las líneas del draft en 1 request (order pad bulk). */
  replaceLines(
    orderId: string,
    lines: { product_id: string; quantity: number }[],
  ): Observable<{ order_id: string; added: number; skipped: { product_id: string; reason: string }[] }> {
    return this.http.put<{ order_id: string; added: number; skipped: { product_id: string; reason: string }[] }>(
      `${this.base}/orders/${orderId}/lines`,
      { lines },
    );
  }

  /** Registra una señal del feedback loop (Fase M, best-effort en el caller). */
  recordSignal(customerId: string, signalType: string, channel = 'vendor'): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/intelligence/signals`, {
      customer_id: customerId,
      signal_type: signalType,
      channel,
    });
  }

  /** Autoventa: entrega inmediata en un paso (draft/pending/confirmed → fulfilled). */
  deliverNow(orderId: string): Observable<VendorOrder> {
    return this.http.post<VendorOrder>(`${this.base}/orders/${orderId}/deliver-now`, {});
  }

  // ─── Por visitar: cobertura del día + check-in ───

  /** Cobertura del día: la cartera del vendedor anotada con visited_today + última visita. */
  coverage(): Observable<CoverageCustomer[]> {
    return this.http.get<CoverageCustomer[]>(`${this.base}/vendor-routes/coverage`);
  }

  /**
   * Registra un check-in de visita al cliente. Si se pasan coords (GPS del
   * vendedor al llegar), el backend las guarda en la visita y —si el cliente aún
   * no tiene coords canónicas— hace backfill capture-on-visit con guard
   * anti-traslape (devuelto en `location`).
   */
  checkIn(
    customerId: string,
    opts: { notes?: string; latitude?: number; longitude?: number } = {},
  ): Observable<{ id: string; location?: SetLocationResult | null }> {
    return this.http.post<{ id: string; location?: SetLocationResult | null }>(
      `${this.base}/vendor-routes/check-in`,
      {
        customer_id: customerId,
        notes: opts.notes || undefined,
        latitude: opts.latitude,
        longitude: opts.longitude,
      },
    );
  }

  /**
   * V.7 — Cierra la visita con su resultado. `had_order`/`had_ticket` los conoce
   * el front (qué se hizo en la visita); el motivo solo cuenta si no hubo venta.
   * Reusa la visita abierta de hoy o crea una (sirve de check-in).
   */
  finishVisit(
    customerId: string,
    opts: {
      had_order?: boolean;
      had_ticket?: boolean;
      no_sale_reason?: string;
      notes?: string;
      latitude?: number;
      longitude?: number;
    } = {},
  ): Observable<{ id: string; location?: SetLocationResult | null }> {
    return this.http.post<{ id: string; location?: SetLocationResult | null }>(
      `${this.base}/vendor-routes/visits/finish`,
      { customer_id: customerId, ...opts },
    );
  }

  /** V.6 — Clientes de la cartera cerca del vendedor (GPS), ordenados por distancia. */
  nearbyCustomers(lat: number, lng: number, radius?: number): Observable<NearbyCustomer[]> {
    let p = new HttpParams().set('lat', String(lat)).set('lng', String(lng));
    if (radius != null) p = p.set('radius', String(radius));
    return this.http.get<NearbyCustomer[]>(`${this.base}/vendor-routes/nearby`, { params: p });
  }

  /** V.6 — Setea/corrige las coords del cliente. `force` confirma pese al guard anti-traslape. */
  setCustomerLocation(
    customerId: string,
    lat: number,
    lng: number,
    force = false,
  ): Observable<SetLocationResult> {
    return this.http.post<SetLocationResult>(
      `${this.base}/vendor-routes/customers/${customerId}/location`,
      { latitude: lat, longitude: lng, force },
    );
  }

  // ─── My day: pedidos tomados HOY por este vendedor ───

  myOrdersToday(): Observable<Order[]> {
    const userId = this.vendorUserId;
    if (!userId) return of([]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const params = new HttpParams()
      .set('from', today.toISOString())
      .set('user_id', userId)
      .set('pageSize', '50');
    return this.http
      .get<{ data: Order[] }>(`${this.base}/orders`, { params })
      .pipe(map((r) => r.data || []));
  }

  // ─── Warehouses (para default) ───

  defaultWarehouseId(): Observable<string | null> {
    return this.portal.listWarehouses().pipe(
      map((whs) => {
        const def = whs.find((w: any) => w.is_default) || whs[0];
        return def?.id || null;
      }),
    );
  }

  // ─── Cierre de ruta: 3 tickets (venta/carga/combustible) ───

  /** Sube la foto → OCR (Claude) → campos parseados SIN guardar (preview). */
  procesarTicket(ticketType: RouteTicketType, file: File): Observable<ProcesarRouteTicketResult> {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('ticket_type', ticketType);
    // No seteamos Content-Type: HttpClient pone el boundary multipart solo.
    return this.http.post<ProcesarRouteTicketResult>(
      `${this.base}/route-tickets/procesar`,
      fd,
    );
  }

  /** Guarda el ticket revisado. */
  guardarTicket(dto: {
    ticket_type: RouteTicketType;
    route_code: string;
    ticket_date: string;
    ticket_time?: string | null;
    total?: number | null;
    corte_number?: string | null;
    reference?: string | null;
    liters?: number | null;
    folio?: string | null; // solo carga
    cloudinary_public_id?: string | null;
    photo_url?: string | null;
    photo_preview_url?: string | null;
    ocr_json?: unknown;
    lines?: { product_id: string; quantity: number }[]; // solo carga
  }): Observable<RouteTicket> {
    return this.http.post<RouteTicket>(`${this.base}/route-tickets`, dto);
  }

  /** Lista los tickets del propio vendedor. */
  listTickets(opts: { ticket_type?: RouteTicketType; pageSize?: number } = {}): Observable<{
    data: RouteTicket[];
    total: number;
  }> {
    let p = new HttpParams().set('pageSize', String(opts.pageSize ?? 30));
    if (opts.ticket_type) p = p.set('ticket_type', opts.ticket_type);
    return this.http.get<{ data: RouteTicket[]; total: number }>(
      `${this.base}/route-tickets`,
      { params: p },
    );
  }

  // ── Horus: lo que el Supervisor IA dejó para ESTE colaborador (self-scoped) ──
  private readonly supBase = environment.apiUrl + '/supervisor-ai/field';

  mySupervisorTasks(): Observable<SupervisorTask[]> {
    return this.http
      .get<{ rows: SupervisorTask[] }>(`${this.supBase}/my-tasks`)
      .pipe(map((r) => r.rows || []));
  }
  mySupervisorCoaching(): Observable<SupervisorCoaching[]> {
    return this.http
      .get<{ rows: SupervisorCoaching[] }>(`${this.supBase}/my-coaching`)
      .pipe(map((r) => r.rows || []));
  }
  ackSupervisorTask(id: string): Observable<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`${this.supBase}/tasks/${id}/ack`, {});
  }
  ackSupervisorCoaching(id: string): Observable<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`${this.supBase}/coaching/${id}/ack`, {});
  }
}

export interface SupervisorTask {
  id: string;
  task_type: 'visit' | 'recover' | 'reprioritize' | 'recapture';
  title: string;
  details?: Record<string, unknown>;
  status: string;
  due_date?: string | null;
  store_id?: string | null;
  route_id?: string | null;
  created_at: string;
}

export interface SupervisorCoaching {
  id: string;
  category: string;
  message: string;
  status: string;
  created_at: string;
}
