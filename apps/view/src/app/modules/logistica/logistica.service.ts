import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

// ── Tipos ────────────────────────────────────────────────────────────────

export type VehicleStatus = 'disponible' | 'en_ruta' | 'mantenimiento' | 'baja';
export type DriverRole = 'chofer' | 'ayudante' | 'cargador';
export type DriverStatus = 'activo' | 'inactivo' | 'suspendido';
export type ShipmentStatus =
  | 'programado'
  | 'checklist_salida'
  | 'en_ruta'
  | 'entregado'
  | 'checklist_llegada'
  | 'costos_pendientes'
  | 'cerrado'
  | 'cancelado';
export type ShipmentType = 'entrega' | 'traspaso' | 'recoleccion';
export type GuideStatus = 'pendiente' | 'en_ruta' | 'entregada' | 'cancelada';
export type RecipientStatus = 'pendiente' | 'entregado' | 'no_entregado' | 'rechazado';
export type PeriodStatus = 'abierto' | 'calculado' | 'pagado' | 'cerrado';
export type LiquidationStatus = 'calculado' | 'revisado' | 'pagado' | 'anulado';
export type ConfigCategory = 'factor' | 'costo_km' | 'tarifa_maniobra' | 'viatico' | 'otro';

export interface Vehicle {
  id: string;
  plate: string;
  model?: string | null;
  brand?: string | null;
  year?: number | null;
  fuel_efficiency_km_l?: number | null;
  capacity_boxes?: number | null;
  capacity_kg?: number | null;
  status: VehicleStatus;
  active: boolean;
  notes?: string | null;
}

export type BloodType = 'O+' | 'O-' | 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-';

export interface Driver {
  id: string;
  full_name: string;
  roles: DriverRole[];
  employee_type: 'interno' | 'externo';
  status: DriverStatus;
  nss?: string | null;
  phone?: string | null;
  emergency_contact?: string | null;
  emergency_phone?: string | null;
  user_id?: string | null;
  active: boolean;
  notes?: string | null;
  curp?: string | null;
  rfc?: string | null;
  blood_type?: BloodType | null;
  federal_license?: string | null;
  hire_date?: string | null;
  base_salary_biweekly?: number | null;
}

export interface ConfigItem {
  id: string;
  key: string;
  category: ConfigCategory;
  description?: string | null;
  value: number;
  unit?: string | null;
  active: boolean;
}

export interface Shipment {
  id: string;
  folio: string;
  shipment_date: string;
  vehicle_id?: string | null;
  route_id?: string | null;
  order_id?: string | null;
  origin?: string | null;
  destination?: string | null;
  actual_km?: number | null;
  freight_revenue: number;
  cargo_value: number;
  boxes_count: number;
  total_weight_kg: number;
  type: ShipmentType;
  status: ShipmentStatus;
  departure_at?: string | null;
  arrival_at?: string | null;
  closed_at?: string | null;
  notes?: string | null;
  // Campos opcionales que vienen de JOIN (my-driver endpoint, ?include=...)
  vehicle_plate?: string | null;
  vehicle_model?: string | null;
  route_name?: string | null;
  order_code?: string | null;
  customer_name?: string | null;
}

export interface ShipmentsPage {
  items: Shipment[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** J.7.1 — pedido confirmed esperando shipment. */
export interface PendingOrder {
  id: string;
  code: string;
  created_at: string;
  confirmed_at: string | null;
  total: number;
  delivery_type: 'route' | 'long_trip';
  customer_id: string;
  customer_name: string | null;
  customer_code: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
}

export interface GuideRecipient {
  id: string;
  guide_id: string;
  customer_id?: string | null;
  customer_name: string;
  address?: string | null;
  boxes_count: number;
  weight_kg: number;
  value: number;
  status: RecipientStatus;
  delivered_at?: string | null;
  delivered_to?: string | null;
  proof_photo_url?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  notes?: string | null;
}

export interface DeliveryGuide {
  id: string;
  number: string;
  shipment_id: string;
  type: string;
  status: GuideStatus;
  driver_id?: string | null;
  driver_commission: number;
  helper1_id?: string | null;
  helper1_commission: number;
  helper2_id?: string | null;
  helper2_commission: number;
  overnight: boolean;
  per_diem_total: number;
  per_diem_breakdown?: any;
  notes?: string | null;
  recipients?: GuideRecipient[];
}

export interface ShipmentExpense {
  id?: string;
  shipment_id: string;
  fuel: number;
  tolls: number;
  lodging: number;
  parking: number;
  permits: number;
  repairs: number;
  external_helpers: number;
  handling: number;
  driver_per_diem: number;
  other: number;
  operating_subtotal: number;
  fixed_cost_per_km: number;
  total_cost: number;
  extras?: Array<{ label: string; amount: number }> | null;
  notes?: string | null;
}

export interface PayrollPeriod {
  id: string;
  number: number;
  year: number;
  start_date: string;
  end_date: string;
  payment_date: string;
  status: PeriodStatus;
  notes?: string | null;
}

export interface Liquidation {
  id: string;
  driver_id: string;
  driver_name?: string;
  employee_type?: string;
  period_id: string;
  per_diem_amount: number;
  commissions_amount: number;
  load_unload_amount: number;
  bonuses: number;
  deductions: number;
  subtotal: number;
  net_amount: number;
  status: LiquidationStatus;
  paid_at?: string | null;
  notes?: string | null;
}

export type AdjustmentType = 'anticipo' | 'prestamo' | 'multa' | 'falta' | 'bono';

export interface PayrollAdjustment {
  id: string;
  driver_id: string;
  driver_name?: string;
  period_id: string;
  type: AdjustmentType;
  amount: number;
  date: string;
  notes?: string | null;
  created_at?: string;
}

export interface CreateAdjustmentBody {
  driver_id: string;
  period_id: string;
  type: AdjustmentType;
  amount: number;
  date: string;
  notes?: string;
}

// ── J.8 (migración repo origen) ──────────────────────────────────────────

export type ChecklistType = 'salida' | 'llegada';
export type ChecklistStatus = 'pendiente' | 'completado';

export interface ChecklistItem {
  id: string;
  label: string;
  required?: boolean;
  group?: string;
}

export interface ChecklistResponse {
  ok: boolean;
  comment?: string;
  photo_url?: string;
}

export interface Checklist {
  id: string;
  shipment_id: string;
  type: ChecklistType;
  status: ChecklistStatus;
  items: ChecklistItem[];
  responses?: Record<string, ChecklistResponse> | null;
  driver_id?: string | null;
  signed_by_user_id?: string | null;
  completed_at?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export type PhotoCategory =
  | 'loading'
  | 'transit'
  | 'delivery'
  | 'incident'
  | 'checklist'
  | 'other';

export interface ShipmentPhoto {
  id: string;
  shipment_id: string;
  guide_id?: string | null;
  driver_id?: string | null;
  uploaded_by_user_id?: string | null;
  category: PhotoCategory;
  url: string;
  cloudinary_public_id?: string | null;
  description?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  captured_at?: string | null;
  uploaded_at: string;
}

export interface UploadPhotoBody {
  shipment_id: string;
  category?: PhotoCategory;
  description?: string;
  image_base64?: string; // o data URL
  external_url?: string;
  cloudinary_public_id?: string;
  guide_id?: string;
  driver_id?: string;
  gps_lat?: number;
  gps_lng?: number;
  captured_at?: string;
}

// J.9 — Analytics overview (dashboard ops)
export interface AnalyticsOverview {
  period: { from: string | null; to: string | null };
  currency: string;
  shipments: { count: number; total_boxes: number; total_km: number; avg_km_per_shipment: number };
  revenue: { freight: number; cargo_value_moved: number };
  cost: { total: number; operating: number; per_km: number };
  margin: { gross: number; gross_pct: number };
}

export interface ShipmentProfitabilityRow {
  id: string;
  folio: string;
  shipment_date: string;
  vehicle_plate?: string;
  route_name?: string;
  km: number;
  revenue: number;
  cost: number;
  margin: number;
  margin_pct: number;
  revenue_per_km?: number;
  cost_per_km?: number;
}

export interface FleetUtilizationRow {
  vehicle_id: string;
  plate: string;
  model?: string;
  shipments_count: number;
  total_km: number;
  total_revenue: number;
  total_cost: number;
  margin: number;
  revenue_per_km?: number;
}

export interface PendingByRouteRow {
  route_id: string | null;
  route_name: string;
  orders_count: number;
  orders_confirmed: number;
  orders_pending_approval: number;
  total_value: number;
  oldest_order_at: string;
}

export interface ExpenseRow {
  id: string;
  shipment_id: string;
  shipment_folio: string;
  shipment_date: string;
  destination?: string | null;
  actual_km?: number | null;
  shipment_status: string;
  vehicle_plate?: string | null;
  fuel: number;
  tolls: number;
  lodging: number;
  parking: number;
  permits: number;
  repairs: number;
  external_helpers: number;
  handling: number;
  driver_per_diem: number;
  other: number;
  operating_subtotal: number;
  fixed_cost_per_km: number;
  total_cost: number;
}

export interface ExpenseSummary {
  fuel: number;
  tolls: number;
  lodging: number;
  parking: number;
  permits: number;
  repairs: number;
  external_helpers: number;
  handling: number;
  driver_per_diem: number;
  other: number;
  operating_subtotal: number;
  total_cost: number;
  count: number;
}

// J.9.9 — Vehicle usage log
export interface VehicleUsageLog {
  id: string;
  vehicle_id: string;
  vehicle_plate?: string;
  vehicle_model?: string;
  driver_id?: string | null;
  driver_name?: string | null;
  shipment_id?: string | null;
  shipment_folio?: string | null;
  check_in_at: string;
  check_in_km: number;
  check_out_at?: string | null;
  check_out_km?: number | null;
  fuel_loaded_liters?: number | null;
  check_in_notes?: string | null;
  check_out_notes?: string | null;
  status: 'en_uso' | 'cerrado';
}

// J.9.9 — Vehicle maintenance
export interface VehicleMaintenance {
  id: string;
  vehicle_id: string;
  vehicle_plate?: string;
  vehicle_model?: string;
  type: 'preventivo' | 'correctivo' | 'inspeccion';
  service_date: string;
  km_at_service?: number | null;
  vendor?: string | null;
  description: string;
  cost: number;
  next_service_date?: string | null;
  next_service_km?: number | null;
  notes?: string | null;
}

// J.9.8 — routes (Comisiones por ruta)
export interface Route {
  id: string;
  name: string;
  origin?: string | null;
  destination?: string | null;
  estimated_km?: number | null;
  driver_commission: number;
  helper_commission: number;
  active: boolean;
  notes?: string | null;
}

export interface KpiSummary {
  period: { from: string; to: string };
  shipments: {
    total: number;
    cerrados: number;
    cancelados: number;
    activos: number;
  };
  operations: {
    km_total: number;
    cajas: number;
  };
  financial: {
    revenue: number;
    total_costos: number;
    combustible: number;
    casetas: number;
    comisiones: number;
    viaticos: number;
    margen: number;
    costo_promedio_km: number;
  };
}

export interface CalculatePeriodResult {
  period_id: string;
  period: string;
  liquidations_processed: number;
  results: Array<{
    driver_id: string;
    full_name: string;
    subtotal: number;
    net_amount: number;
    action: 'created' | 'updated';
  }>;
}

// ── J12.0 Carta Porte ──────────────────────────────────────────────────────
export interface EmisorProfile {
  id?: string;
  rfc: string;
  legal_name: string;
  regimen_fiscal: string;
  cp_expedicion: string;
  sct_permit_type?: string | null;
  sct_permit_number?: string | null;
  fiscal_address?: Record<string, unknown> | null;
}
export interface CartaPorteGap {
  field: string;
  detail: string;
}
export type CartaPorteStatus = 'borrador' | 'timbrado' | 'cancelado' | 'error';
export interface CartaPorteDocument {
  id: string;
  shipment_id: string;
  cfdi_type: 'traslado' | 'ingreso';
  status: CartaPorteStatus;
  uuid_fiscal?: string | null;
  serie?: string | null;
  folio?: string | null;
  total_distance_km?: number | null;
  pac_provider?: string | null;
  error_message?: string | null;
  stamped_at?: string | null;
  created_at: string;
}

export interface CustomerLite {
  id: string;
  code: string;
  name: string;
  billing_address?: Record<string, any> | null;
  shipping_address?: Record<string, any> | null;
}

export interface OrderLite {
  id: string;
  code: string;
  total: number;
  status: string;
}

// ── J12.1 Rastreo en vivo ───────────────────────────────────────────────────
export interface LiveShipment {
  shipment_id: string;
  folio: string;
  destination?: string | null;
  driver_name: string;
  vehicle_plate?: string | null;
  lat: number;
  lng: number;
  accuracy_m?: number | null;
  captured_at: string;
}

@Injectable({ providedIn: 'root' })
export class LogisticaService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/logistics`;

  // ── Config ───────────────────────────────────────────────────────────────
  listConfig(category?: ConfigCategory, active?: boolean): Observable<ConfigItem[]> {
    let p = new HttpParams();
    if (category) p = p.set('category', category);
    if (active !== undefined) p = p.set('active', String(active));
    return this.http.get<ConfigItem[]>(`${this.base}/config`, { params: p });
  }
  createConfig(body: Partial<ConfigItem>) {
    return this.http.post<ConfigItem>(`${this.base}/config`, body);
  }
  updateConfig(id: string, body: Partial<ConfigItem>) {
    return this.http.patch<ConfigItem>(`${this.base}/config/${id}`, body);
  }
  deleteConfig(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/config/${id}`);
  }

  // J.9.8 — Routes (Comisiones por ruta)
  listRoutes(opts: { active?: boolean; search?: string } = {}): Observable<Route[]> {
    let p = new HttpParams();
    if (opts.active !== undefined) p = p.set('active', String(opts.active));
    if (opts.search) p = p.set('search', opts.search);
    return this.http.get<Route[]>(`${this.base}/config/routes/list`, { params: p });
  }
  createRoute(body: Partial<Route>) {
    return this.http.post<Route>(`${this.base}/config/routes`, body);
  }
  updateRoute(id: string, body: Partial<Route>) {
    return this.http.patch<Route>(`${this.base}/config/routes/${id}`, body);
  }
  deleteRoute(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/config/routes/${id}`);
  }

  // ── Fleet: vehicles ──────────────────────────────────────────────────────
  listVehicles(opts: { active?: boolean; status?: string } = {}): Observable<Vehicle[]> {
    let p = new HttpParams();
    if (opts.active !== undefined) p = p.set('active', String(opts.active));
    if (opts.status) p = p.set('status', opts.status);
    return this.http.get<Vehicle[]>(`${this.base}/fleet/vehicles`, { params: p });
  }
  getVehicle(id: string) {
    return this.http.get<Vehicle>(`${this.base}/fleet/vehicles/${id}`);
  }
  createVehicle(body: Partial<Vehicle>) {
    return this.http.post<Vehicle>(`${this.base}/fleet/vehicles`, body);
  }
  updateVehicle(id: string, body: Partial<Vehicle>) {
    return this.http.patch<Vehicle>(`${this.base}/fleet/vehicles/${id}`, body);
  }
  deleteVehicle(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/fleet/vehicles/${id}`);
  }

  // ── Fleet: drivers ───────────────────────────────────────────────────────
  listDrivers(opts: { active?: boolean; role?: DriverRole; search?: string } = {}): Observable<Driver[]> {
    let p = new HttpParams();
    if (opts.active !== undefined) p = p.set('active', String(opts.active));
    if (opts.role) p = p.set('role', opts.role);
    if (opts.search) p = p.set('search', opts.search);
    return this.http.get<Driver[]>(`${this.base}/fleet/drivers`, { params: p });
  }
  createDriver(body: Partial<Driver>) {
    return this.http.post<Driver>(`${this.base}/fleet/drivers`, body);
  }
  updateDriver(id: string, body: Partial<Driver>) {
    return this.http.patch<Driver>(`${this.base}/fleet/drivers/${id}`, body);
  }
  deleteDriver(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/fleet/drivers/${id}`);
  }

  // J.9.9 — Vehicle usage (check-in / check-out)
  vehicleCheckIn(body: { vehicle_id: string; driver_id?: string; shipment_id?: string; check_in_km: number; check_in_notes?: string }) {
    return this.http.post<VehicleUsageLog>(`${this.base}/fleet/usage/check-in`, body);
  }
  vehicleCheckOut(usageId: string, body: { check_out_km: number; fuel_loaded_liters?: number; check_out_notes?: string }) {
    return this.http.post<VehicleUsageLog>(`${this.base}/fleet/usage/${usageId}/check-out`, body);
  }
  listVehicleUsage(opts: { vehicle_id?: string; status?: string; limit?: number } = {}): Observable<VehicleUsageLog[]> {
    let p = new HttpParams();
    Object.entries(opts).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v)); });
    return this.http.get<VehicleUsageLog[]>(`${this.base}/fleet/usage`, { params: p });
  }

  // J.9.9 — Vehicle maintenance
  createMaintenance(body: Partial<VehicleMaintenance>) {
    return this.http.post<VehicleMaintenance>(`${this.base}/fleet/maintenance`, body);
  }
  listMaintenance(opts: { vehicle_id?: string; type?: string; limit?: number } = {}): Observable<VehicleMaintenance[]> {
    let p = new HttpParams();
    Object.entries(opts).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v)); });
    return this.http.get<VehicleMaintenance[]>(`${this.base}/fleet/maintenance`, { params: p });
  }
  deleteMaintenance(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/fleet/maintenance/${id}`);
  }

  // ── Shipments + state machine ────────────────────────────────────────────
  listShipments(opts: {
    status?: ShipmentStatus;
    vehicle_id?: string;
    driver_id?: string;
    order_id?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  } = {}): Observable<ShipmentsPage> {
    let p = new HttpParams();
    Object.entries(opts).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v)); });
    return this.http.get<ShipmentsPage>(`${this.base}/shipments`, { params: p });
  }
  /**
   * J.7.1 — pedidos confirmed sin shipment activo asociado (bandeja de logística).
   * Devuelve array directo (no paginado — la cola raramente excede decenas).
   */
  listPendingOrders(): Observable<PendingOrder[]> {
    return this.http.get<PendingOrder[]>(`${this.base}/shipments/pending-orders`);
  }
  /** J.9.7 — shipments del chofer logueado (mobile-first). */
  listMyDriverShipments(opts: { status?: ShipmentStatus; from?: string; to?: string } = {}): Observable<Shipment[]> {
    let p = new HttpParams();
    Object.entries(opts).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v)); });
    return this.http.get<Shipment[]>(`${this.base}/shipments/my-driver`, { params: p });
  }
  getShipment(id: string) {
    return this.http.get<Shipment>(`${this.base}/shipments/${id}`);
  }
  createShipment(body: Partial<Shipment>) {
    return this.http.post<Shipment>(`${this.base}/shipments`, body);
  }
  updateShipment(id: string, body: Partial<Shipment>) {
    return this.http.patch<Shipment>(`${this.base}/shipments/${id}`, body);
  }
  shipmentDepart(id: string) { return this.http.post<Shipment>(`${this.base}/shipments/${id}/depart`, {}); }
  shipmentDeliver(id: string) { return this.http.post<Shipment>(`${this.base}/shipments/${id}/deliver`, {}); }
  shipmentClose(id: string) { return this.http.post<Shipment>(`${this.base}/shipments/${id}/close`, {}); }
  shipmentCancel(id: string, reason?: string) {
    return this.http.post<Shipment>(`${this.base}/shipments/${id}/cancel`, { reason });
  }
  deleteShipment(id: string) { return this.http.delete<{ deleted: boolean }>(`${this.base}/shipments/${id}`); }
  // J.8 — transiciones nuevas del state machine extendido
  shipmentStartSalidaChecklist(id: string) {
    return this.http.post<Shipment>(`${this.base}/shipments/${id}/start-salida-checklist`, {});
  }
  shipmentStartLlegadaChecklist(id: string) {
    return this.http.post<Shipment>(`${this.base}/shipments/${id}/start-llegada-checklist`, {});
  }
  shipmentMarkCostsPending(id: string) {
    return this.http.post<Shipment>(`${this.base}/shipments/${id}/mark-costs-pending`, {});
  }

  // ── J.8 Checklists ───────────────────────────────────────────────────────
  getChecklistTemplate(type: 'salida' | 'llegada') {
    return this.http.get<{ type: 'salida' | 'llegada'; items: ChecklistItem[] }>(
      `${this.base}/checklists/template/${type}`,
    );
  }
  createChecklist(body: {
    shipment_id: string;
    type: 'salida' | 'llegada';
    items: ChecklistItem[];
    driver_id?: string;
  }) {
    return this.http.post<Checklist>(`${this.base}/checklists`, body);
  }
  listChecklistsByShipment(shipmentId: string): Observable<Checklist[]> {
    return this.http.get<Checklist[]>(`${this.base}/checklists/shipment/${shipmentId}`);
  }
  getChecklist(id: string) {
    return this.http.get<Checklist>(`${this.base}/checklists/${id}`);
  }
  completeChecklist(id: string, body: { responses: Record<string, ChecklistResponse>; notes?: string }) {
    return this.http.post<Checklist>(`${this.base}/checklists/${id}/complete`, body);
  }

  // ── J.8 Photos ───────────────────────────────────────────────────────────
  uploadPhoto(body: UploadPhotoBody) {
    return this.http.post<ShipmentPhoto>(`${this.base}/photos`, body);
  }
  listPhotosByShipment(shipmentId: string, category?: PhotoCategory): Observable<ShipmentPhoto[]> {
    let p = new HttpParams();
    if (category) p = p.set('category', category);
    return this.http.get<ShipmentPhoto[]>(`${this.base}/photos/shipment/${shipmentId}`, { params: p });
  }
  listPhotosByGuide(guideId: string): Observable<ShipmentPhoto[]> {
    return this.http.get<ShipmentPhoto[]>(`${this.base}/photos/guide/${guideId}`);
  }
  deletePhoto(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/photos/${id}`);
  }

  // ── J.8 Reports ──────────────────────────────────────────────────────────
  shipmentPdfUrl(id: string): string {
    return `${this.base}/reports/shipment/${id}/pdf`;
  }
  kpiSummary(from?: string, to?: string): Observable<KpiSummary> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return this.http.get<KpiSummary>(`${this.base}/reports/kpi`, { params: p });
  }
  kpiPdfUrl(from?: string, to?: string): string {
    const params: string[] = [];
    if (from) params.push(`from=${from}`);
    if (to) params.push(`to=${to}`);
    return `${this.base}/reports/kpi/pdf${params.length ? '?' + params.join('&') : ''}`;
  }
  downloadShipmentPdf(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/reports/shipment/${id}/pdf`, { responseType: 'blob' });
  }
  downloadKpiPdf(from?: string, to?: string): Observable<Blob> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return this.http.get(`${this.base}/reports/kpi/pdf`, { params: p, responseType: 'blob' });
  }

  // ── J.9 Analytics (Dashboard ops) ────────────────────────────────────────
  analyticsOverview(from?: string, to?: string): Observable<AnalyticsOverview> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return this.http.get<AnalyticsOverview>(`${this.base}/analytics/overview`, { params: p });
  }
  shipmentProfitability(opts: {
    from?: string; to?: string; vehicle_id?: string; route_id?: string; limit?: number;
  } = {}): Observable<ShipmentProfitabilityRow[]> {
    let p = new HttpParams();
    Object.entries(opts).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v)); });
    return this.http.get<ShipmentProfitabilityRow[]>(`${this.base}/analytics/shipment-profitability`, { params: p });
  }
  fleetUtilization(from?: string, to?: string): Observable<FleetUtilizationRow[]> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return this.http.get<FleetUtilizationRow[]>(`${this.base}/analytics/fleet-utilization`, { params: p });
  }
  pendingByRoute(): Observable<PendingByRouteRow[]> {
    return this.http.get<PendingByRouteRow[]>(`${this.base}/analytics/pending-by-route`);
  }

  // ── J.9 Expenses summary (Costs page KPI) ────────────────────────────────
  expensesSummary(from?: string, to?: string): Observable<ExpenseSummary> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return this.http.get<ExpenseSummary>(`${this.base}/expenses/summary`, { params: p });
  }
  listExpenses(opts: { from?: string; to?: string; limit?: number } = {}): Observable<ExpenseRow[]> {
    let p = new HttpParams();
    Object.entries(opts).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v)); });
    return this.http.get<ExpenseRow[]>(`${this.base}/expenses`, { params: p });
  }

  // ── Guides + recipients ──────────────────────────────────────────────────
  listGuides(shipmentId?: string): Observable<DeliveryGuide[]> {
    let p = new HttpParams();
    if (shipmentId) p = p.set('shipment_id', shipmentId);
    return this.http.get<DeliveryGuide[]>(`${this.base}/guides`, { params: p });
  }
  getGuide(id: string) {
    return this.http.get<DeliveryGuide>(`${this.base}/guides/${id}`);
  }
  createGuide(body: Partial<DeliveryGuide> & {
    shipment_id: string;
    auto_commissions?: boolean;
    auto_per_diem?: boolean;
    per_diem_breakdown?: any;
  }) {
    return this.http.post<DeliveryGuide>(`${this.base}/guides`, body);
  }
  updateGuide(id: string, body: Partial<DeliveryGuide>) {
    return this.http.patch<DeliveryGuide>(`${this.base}/guides/${id}`, body);
  }
  deleteGuide(id: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/guides/${id}`);
  }
  addRecipient(guideId: string, body: Partial<GuideRecipient> & { customer_name: string }) {
    return this.http.post<GuideRecipient>(`${this.base}/guides/${guideId}/recipients`, body);
  }
  markRecipientDelivered(recipientId: string, body: Partial<GuideRecipient>) {
    return this.http.post<GuideRecipient>(`${this.base}/guides/recipients/${recipientId}/deliver`, body);
  }
  removeRecipient(recipientId: string) {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/guides/recipients/${recipientId}`);
  }

  // ── Expenses ─────────────────────────────────────────────────────────────
  getExpense(shipmentId: string): Observable<ShipmentExpense> {
    return this.http.get<ShipmentExpense>(`${this.base}/expenses/shipments/${shipmentId}`);
  }
  upsertExpense(shipmentId: string, body: Partial<ShipmentExpense> & { apply_config_km?: boolean }) {
    return this.http.put<ShipmentExpense>(`${this.base}/expenses/shipments/${shipmentId}`, body);
  }
  expenseSummary(from?: string, to?: string): Observable<Record<string, number>> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return this.http.get<Record<string, number>>(`${this.base}/expenses/summary`, { params: p });
  }

  // ── Payroll ──────────────────────────────────────────────────────────────
  listPeriods(year?: number): Observable<PayrollPeriod[]> {
    let p = new HttpParams();
    if (year) p = p.set('year', String(year));
    return this.http.get<PayrollPeriod[]>(`${this.base}/payroll/periods`, { params: p });
  }
  createPeriod(body: Partial<PayrollPeriod>) {
    return this.http.post<PayrollPeriod>(`${this.base}/payroll/periods`, body);
  }
  updatePeriod(id: string, body: Partial<PayrollPeriod>) {
    return this.http.patch<PayrollPeriod>(`${this.base}/payroll/periods/${id}`, body);
  }
  calculatePeriod(id: string) {
    return this.http.post<CalculatePeriodResult>(`${this.base}/payroll/periods/${id}/calculate`, {});
  }
  listLiquidations(periodId: string): Observable<Liquidation[]> {
    return this.http.get<Liquidation[]>(`${this.base}/payroll/periods/${periodId}/liquidations`);
  }
  updateLiquidation(id: string, body: Partial<Liquidation>) {
    return this.http.patch<Liquidation>(`${this.base}/payroll/liquidations/${id}`, body);
  }

  // ── Payroll adjustments ────────────────────────────────────────────────
  listAdjustments(filters: { driver_id?: string; period_id?: string }): Observable<PayrollAdjustment[]> {
    let p = new HttpParams();
    if (filters.driver_id) p = p.set('driver_id', filters.driver_id);
    if (filters.period_id) p = p.set('period_id', filters.period_id);
    return this.http.get<PayrollAdjustment[]>(`${this.base}/payroll/adjustments`, { params: p });
  }
  createAdjustment(body: CreateAdjustmentBody) {
    return this.http.post<PayrollAdjustment>(`${this.base}/payroll/adjustments`, body);
  }
  deleteAdjustment(id: string) {
    return this.http.delete<{ deleted: boolean; id: string }>(`${this.base}/payroll/adjustments/${id}`);
  }

  // ── J12.0 Carta Porte ────────────────────────────────────────────────────
  getEmisorProfile(): Observable<EmisorProfile | null> {
    return this.http.get<EmisorProfile | null>(`${this.base}/cartaporte/emisor`);
  }
  upsertEmisorProfile(body: EmisorProfile): Observable<EmisorProfile> {
    return this.http.put<EmisorProfile>(`${this.base}/cartaporte/emisor`, body);
  }
  validateCartaPorte(shipmentId: string): Observable<CartaPorteGap[]> {
    return this.http.get<CartaPorteGap[]>(`${this.base}/cartaporte/shipment/${shipmentId}/validate`);
  }
  stampCartaPorte(shipmentId: string): Observable<CartaPorteDocument> {
    return this.http.post<CartaPorteDocument>(`${this.base}/cartaporte/shipment/${shipmentId}/stamp`, {});
  }
  listCartaPorteByShipment(shipmentId: string): Observable<CartaPorteDocument[]> {
    return this.http.get<CartaPorteDocument[]>(`${this.base}/cartaporte/shipment/${shipmentId}`);
  }

  // ── J12.1 Rastreo en vivo ──────────────────────────────────────────────────
  liveShipments(): Observable<LiveShipment[]> {
    return this.http.get<LiveShipment[]>(`${this.base}/shipments/live`);
  }

  // ── J12.3 Optimización de ruta ─────────────────────────────────────────────
  optimizeShipmentRoute(shipmentId: string): Observable<{ order: string[]; total_km: number; located: number; unlocated: number }> {
    return this.http.post<{ order: string[]; total_km: number; located: number; unlocated: number }>(
      `${this.base}/routing/optimize-shipment/${shipmentId}`, {});
  }

  // ── J12.4 ETA ──────────────────────────────────────────────────────────────
  shipmentEta(shipmentId: string): Observable<ShipmentEta> {
    return this.http.get<ShipmentEta>(`${this.base}/shipments/${shipmentId}/eta`);
  }

  // ── J12.3 Planner ──────────────────────────────────────────────────────────
  shipmentRoutePlan(shipmentId: string): Observable<RoutePlan> {
    return this.http.get<RoutePlan>(`${this.base}/routing/shipment/${shipmentId}/plan`);
  }
  buildShipmentFromOrders(body: { vehicle_id: string; order_ids: string[]; shipment_date: string; driver_id?: string; origin?: string; destination?: string }): Observable<BuildShipmentResult> {
    return this.http.post<BuildShipmentResult>(`${this.base}/routing/build-shipment`, body);
  }

  // ── J12.6 Mantenimiento + combustible ──────────────────────────────────────
  maintenanceDue(): Observable<MaintenanceDue[]> {
    return this.http.get<MaintenanceDue[]>(`${this.base}/fleet/maintenance/due`);
  }
  fuelEfficiency(): Observable<FuelEfficiency[]> {
    return this.http.get<FuelEfficiency[]>(`${this.base}/fleet/fuel-efficiency`);
  }
  vehicleOdometer(vehicleId: string): Observable<{ vehicle_id: string; odometer: number | null }> {
    return this.http.get<{ vehicle_id: string; odometer: number | null }>(`${this.base}/fleet/vehicles/${vehicleId}/odometer`);
  }

  // ── J12.6 Cargas de combustible ────────────────────────────────────────────
  createFuel(body: { vehicle_id: string; driver_id?: string; liters: number; amount?: number; odometer_km?: number; station?: string; loaded_at?: string; notes?: string }): Observable<FuelTransaction> {
    return this.http.post<FuelTransaction>(`${this.base}/fleet/fuel`, body);
  }
  listFuel(opts: { vehicle_id?: string; limit?: number } = {}): Observable<FuelTransaction[]> {
    let p = new HttpParams();
    if (opts.vehicle_id) p = p.set('vehicle_id', opts.vehicle_id);
    if (opts.limit) p = p.set('limit', String(opts.limit));
    return this.http.get<FuelTransaction[]>(`${this.base}/fleet/fuel`, { params: p });
  }
  deleteFuel(id: string): Observable<{ deleted: boolean; id: string }> {
    return this.http.delete<{ deleted: boolean; id: string }>(`${this.base}/fleet/fuel/${id}`);
  }

  // ── J12 autorelleno: búsqueda de clientes para destinatarios ────────────────
  searchCustomers(search: string): Observable<CustomerLite[]> {
    let p = new HttpParams().set('pageSize', '10');
    if (search) p = p.set('search', search);
    return this.http.get<{ items: CustomerLite[] }>(`${environment.apiUrl}/commercial/customers`, { params: p })
      .pipe(map((r) => r.items || []));
  }
  /** Pedidos entregables del cliente (para ligar order_id en el destinatario). */
  customerOrders(customerId: string): Observable<OrderLite[]> {
    const p = new HttpParams()
      .set('customer_id', customerId)
      .set('statuses', 'confirmed,pending_approval')
      .set('pageSize', '20');
    return this.http.get<{ items: OrderLite[] }>(`${environment.apiUrl}/commercial/orders`, { params: p })
      .pipe(map((r) => r.items || []));
  }

  // ── J12.7 ROI ──────────────────────────────────────────────────────────────
  analyticsRoi(from?: string, to?: string): Observable<RoiSummary> {
    let p = new HttpParams();
    if (from) p = p.set('from', from);
    if (to) p = p.set('to', to);
    return this.http.get<RoiSummary>(`${this.base}/analytics/roi`, { params: p });
  }
}

export interface RoiSummary {
  period: { from: string | null; to: string | null };
  currency: string;
  shipments: number;
  km: number;
  revenue_freight: number;
  cost_total: number;
  cost_per_km: number;
  margin: number;
  margin_pct: number;
  fuel_cost: number;
  fuel_pct_of_operating: number;
  maintenance_cost: number;
  cost_breakdown: { fuel: number; tolls: number; driver_per_diem: number; handling: number; repairs: number; otros: number };
}

export interface FuelTransaction {
  id: string;
  vehicle_id: string;
  vehicle_plate?: string | null;
  driver_id?: string | null;
  driver_name?: string | null;
  liters: number;
  amount: number;
  odometer_km?: number | null;
  station?: string | null;
  loaded_at: string;
  notes?: string | null;
}

export interface MaintenanceDue {
  vehicle_id: string;
  plate: string;
  model?: string | null;
  brand?: string | null;
  odometer?: number | null;
  next_service_km?: number | null;
  next_service_date?: string | null;
  last_description?: string | null;
  reasons: string[];
}
export interface FuelEfficiency {
  vehicle_id: string;
  plate: string;
  model?: string | null;
  km: number;
  liters: number;
  trips: number;
  real_km_l: number | null;
  spec_km_l: number | null;
  deviation_pct: number | null;
  flag: boolean;
}

export interface EtaStop {
  recipient_id: string;
  customer_name: string;
  sequence_order: number;
  leg_km: number;
  cumulative_km: number;
  eta: string;
}
export interface ShipmentEta {
  from_source?: 'driver_ping' | 'first_stop';
  speed_kmh?: number;
  speed_source?: 'calibrated' | 'config' | 'default';
  service_minutes?: number;
  stops: EtaStop[];
  total_km: number;
  total_minutes: number;
}

export interface RoutePlanStop {
  recipient_id: string;
  customer_name: string;
  status: string;
  sequence_order: number | null;
  lat: number;
  lng: number;
}
export interface RoutePlan {
  folio: string;
  origin: { lat: number; lng: number; name?: string } | null;
  optimized: boolean;
  stops: RoutePlanStop[];
  unlocated: number;
}
export interface BuildShipmentResult {
  shipment_id: string;
  folio: string;
  guide_number: string;
  recipients: number;
  located: number;
  unlocated: number;
  total_units: number;
  capacity_boxes: number | null;
  over_capacity: boolean;
  optimized_km: number;
}
