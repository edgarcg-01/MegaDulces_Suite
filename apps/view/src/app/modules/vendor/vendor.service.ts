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
}

// ─── Cierre de ruta ───
export type RouteTicketType = 'venta' | 'carga' | 'combustible';

export interface RouteTicketFields {
  route_code: string | null;
  ticket_date: string | null;
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
@Injectable({ providedIn: 'root' })
export class VendorService {
  private readonly http = inject(HttpClient);
  private readonly portal = inject(PortalService);
  private readonly auth = inject(AuthService);
  private readonly base = environment.apiUrl + '/commercial';

  /** sub del JWT del vendedor logueado. Lo usamos para scoping de drafts / "Mi día". */
  private get vendorUserId(): string | null {
    return this.auth.user()?.sub || null;
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
   */
  catalogForCustomer(customerId: string, warehouseId?: string): Observable<PriceRow[]> {
    return forkJoin({
      customer: this.getCustomer(customerId),
      priceLists: this.portal.listPriceLists(),
    }).pipe(
      switchMap(({ customer, priceLists }) => {
        const list =
          (customer.default_price_list_id &&
            priceLists.find((p: any) => p.id === customer.default_price_list_id)) ||
          priceLists.find((p: any) => p.is_default);
        if (!list) return of([]);
        return this.portal.listPricesForList(list.id, warehouseId);
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

  ensureDraftForCustomer(
    customerId: string,
    warehouseId: string,
    deliveryType: 'route' | 'long_trip' = 'route',
  ): Observable<Order> {
    return this.draftForCustomer(customerId).pipe(
      switchMap((existing) => {
        if (existing) return of(existing);
        return this.http.post<Order>(`${this.base}/orders`, {
          customer_id: customerId,
          warehouse_id: warehouseId,
          delivery_type: deliveryType,
        });
      }),
    );
  }

  /**
   * J.6.6 — actualiza header del draft (delivery_type, notes). Solo válido en draft.
   */
  updateDraftHeader(
    orderId: string,
    dto: { delivery_type?: 'route' | 'long_trip'; notes?: string },
  ): Observable<Order> {
    return this.http.patch<Order>(`${this.base}/orders/${orderId}`, dto);
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
}
