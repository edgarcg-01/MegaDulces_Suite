import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** Fase RA (ADR-030) — cliente del proyecto Compras: existencia crítica + requisiciones. */

export type TargetBasis = 'min' | 'reorder' | 'max';
/** Base del pedido en el cockpit (incluye 'cadence', que criticalStock soporta pero la requisición no persiste). */
export type OrderBasis = 'cadence' | 'reorder' | 'max' | 'min';
export type Bucket = 'agotado' | 'bajo_minimo' | 'bajo_reorden' | 'sano' | 'sobrestock';
export type ReorderSource = 'kepler' | 'computed' | 'manual';
export type RequisitionEstado = 'draft' | 'pending_approval' | 'approved' | 'ordered' | 'received' | 'cancelled';
export type SourceType = 'supplier' | 'branch';

export interface CriticalStockRow {
  product_id: string;
  warehouse_id: string;
  warehouse_code: string;
  sku: string;
  nombre: string;
  on_hand: number;
  in_transit: number;
  min_stock: number;
  reorder_point: number;
  max_stock: number;
  source: ReorderSource;
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_min_boxes: number | null;  // RA.13a — pedido mínimo del proveedor en cajas
  supplier_min_amount: number | null; // RA-PRO.10 — pedido mínimo del proveedor en $
  factor_purchase: number | null;     // ⚠ roto (todo 1/null) — NO usar para cajas
  factor_sale: number | null;         // piezas/caja REAL (usar este); ver reference_box_factor_factor_sale
  box_size: number | null;            // pack de la etiquetera — fallback de factor_sale para uxc
  abc_class: string | null;
  // RA-PRO.1/2 — política profesional (safety stock por nivel de servicio + XYZ)
  xyz_class: string | null;          // X estable · Y variable · Z errático
  safety_stock: number | null;
  service_level: number | null;      // 0..1
  demand_cv: number | null;          // coeficiente de variación de demanda
  policy_method: string | null;      // 'service_level' | 'days_cover'
  lead_time_days: number | null;
  avg_daily_units: number | null;
  sales_rank: number | null;         // ranking de ventas en la sucursal (#1 = el que más vende)
  monthly_revenue: number | null;    // venta mensual estimada ($) = demanda × 30 × precio
  unit_cost: number | null;
  bucket: Bucket;
  suggested_qty: number;
  suggested_cost: number;
  // RA-PRO.9 — contexto de canal/ciclo (cómo se surte y cuándo toca)
  replenish_via?: 'purchase' | 'transfer' | null;
  cadence_days?: number | null;
  next_due_date?: string | null;
  cadence_band?: 'rapida' | 'promedio' | 'mal_abasto' | null;
  source_warehouse_code?: string | null;
}
export interface CriticalStockResponse {
  total: number;
  page: number;
  pageSize: number;
  target_basis: TargetBasis;
  rows: CriticalStockRow[];
}
export interface DeadStockRow {
  product_id: string;
  warehouse_id: string;
  warehouse_code: string;
  sku: string;
  nombre: string;
  on_hand: number;           // 0 = descontinuado / nunca surtido en este almacén
  unit_cost: number;
  dead_value: number;        // existencia × costo = capital inmovilizado (0 si sin stock)
  last_activity: string | null; // última venta/movimiento en el almacén; null = nunca
  created_at: string;        // alta en catálogo (fallback del "desde cuándo")
  supplier_name: string | null;
}
export interface DeadStockResponse {
  total: number;
  page: number;
  pageSize: number;
  total_value: number;       // capital inmovilizado total (con los filtros activos)
  rows: DeadStockRow[];
}
export interface ReplenishmentSummary {
  agotado: number;
  bajo_minimo: number;
  bajo_reorden: number;
  sobrestock: number;
  total_policies: number;
  sugerido_costo: number | null;
}
export interface ReplenishmentFilters {
  warehouses: { id: string; code: string; name: string }[];
  suppliers: { id: string; name: string; min_order_boxes: number | null }[];
}
export interface CriticalStockQuery {
  warehouse_id?: string;
  warehouse_ids?: string[]; // RA.12 — multi-sucursal
  supplier_id?: string;
  abc?: string;
  xyz?: string; // RA-PRO.2
  bucket?: string;
  source?: string;
  search?: string;
  target_basis?: string;
  scope?: string;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface RequisitionRow {
  id: string;
  folio: string;
  estado: RequisitionEstado;
  target_basis: TargetBasis;
  total_lines: number;
  total_units: number;
  total_cost: number;
  notes: string | null;
  created_at: string;
  approved_at: string | null;
  warehouse_code: string | null;
  warehouse_name: string | null;
  supplier_name: string | null;
}
export interface RequisitionLine {
  id: string;
  product_id: string;
  sku: string;
  nombre: string;
  supplier_name: string | null;
  source_type: SourceType;
  source_warehouse_id: string | null;
  on_hand: number;
  in_transit: number;
  min_stock: number;
  reorder_point: number;
  max_stock: number;
  suggested_qty: number;
  final_qty: number;
  received_qty: number | null;
  unit_cost: number;
  line_cost: number;
}
export interface RequisitionDetail extends RequisitionRow {
  lines: RequisitionLine[];
  purchase_order_id: string | null;   // RA.15 — OC generada desde esta requisición
  purchase_order_folio: string | null;
}
export interface CreateRequisitionLine {
  product_id: string;
  supplier_id?: string | null;
  source_type?: SourceType;
  source_warehouse_id?: string | null;
  on_hand?: number;
  in_transit?: number;
  min_stock?: number;
  reorder_point?: number;
  max_stock?: number;
  suggested_qty?: number;
  final_qty: number;
  unit_cost?: number;
}
export interface CreateRequisitionDto {
  warehouse_id: string;
  supplier_id?: string | null;
  source_type?: SourceType;
  source_warehouse_id?: string | null;
  target_basis?: TargetBasis;
  notes?: string;
  lines: CreateRequisitionLine[];
}
export interface ReceiveLine { line_id: string; received_qty: number; }

export interface NetworkNode {
  id: string;
  code: string;
  name: string;
  source_warehouse_id: string | null;
  source_code: string | null;
  is_cedis: boolean;
}

export interface SupplierParam {
  id: string;
  name: string;
  lead_time_days: number | null;
  min_order_boxes: number | null;
  cadence_days_override: number | null; // RA-PRO.10 — ciclo de pedido manual (días)
  colchon_days: number | null;          // RA-PRO.10 — colchón en días de demanda
  min_order_amount: number | null;      // RA-PRO.10 — mínimo de compra en $
  product_count: number;
}
export interface SupplierOrderParamsDto {
  cadence_days_override?: number | null;
  colchon_days?: number | null;
  min_order_amount?: number | null;
  min_order_boxes?: number | null;
}
export interface SupplierOrderLine {
  warehouse_code: string; warehouse_id: string; product_id: string; sku: string; nombre: string;
  on_hand: number; avg_daily: number; uxc: number; unit_cost: number;
  suggested: number; final: number; cajas: number; line_cost: number;
}
export interface SupplierOrder {
  supplier: { id: string; name: string; cadence_days_override: number | null; colchon_days: number | null; min_order_boxes: number | null; min_order_amount: number | null };
  padded: boolean; // se subió al mínimo
  totals: { cajas: number; amount: number; lines: number; suggested_cajas: number; suggested_amount: number };
  lines: SupplierOrderLine[];
}

// ── RA.15 (ADR-031) — Orden de Compra (OC) + Orden de Entrada (OE) ──────
export type PurchaseOrderEstado = 'open' | 'partial' | 'received' | 'cancelled';
export interface PurchaseOrderRow {
  id: string;
  folio: string;
  estado: PurchaseOrderEstado;
  source_type: SourceType;
  expected_date: string | null;
  total_lines: number;
  total_units: number;
  received_units: number;
  total_cost: number;
  created_at: string;
  closed_at: string | null;
  warehouse_code: string | null;
  supplier_name: string | null;
  source_code: string | null;
}
export interface PurchaseOrderLine {
  id: string;
  product_id: string;
  sku: string;
  nombre: string;
  ordered_qty: number;
  received_qty: number;
  unit_cost: number;
  line_cost: number;
}
export interface PurchaseOrderReceipt {
  id: string;
  folio: string;
  total_units: number;
  total_cost: number;
  stock_applied: boolean;
  received_at: string;
  notes: string | null;
}
export interface PurchaseOrderDetail extends PurchaseOrderRow {
  warehouse_name: string | null;
  source_warehouse_id: string | null;
  requisition_id: string | null;
  requisition_folio: string | null;
  notes: string | null;
  lines: PurchaseOrderLine[];
  receipts: PurchaseOrderReceipt[];
}
export interface CreateReceiptLine { po_line_id: string; received_qty: number; unit_cost?: number; }

export type FindingKind = 'agotado_abc' | 'bajo_reorden' | 'cadencia_lenta';
export type FindingSeverity = 'critica' | 'alta' | 'media';
export interface ReplenishmentFinding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  status: 'open' | 'resolved';
  abc_class: string | null;
  on_hand: number;
  reorder_point: number;
  in_transit: number;
  suggested_qty: number;
  suggested_cost: number;
  first_seen_at: string;
  last_seen_at: string;
  sku: string;
  nombre: string;
  warehouse_code: string | null;
  supplier_name: string | null;
}

// ── RA-PRO.8 — Worklist "Qué toca" (ciclos de reabasto) ────────────────
export type ReplenishVia = 'purchase' | 'transfer';
export type CadenceBand = 'rapida' | 'promedio' | 'mal_abasto';
export interface WorklistRow {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string | null;
  supplier_id: string;
  supplier_name: string | null;
  via: ReplenishVia;
  source_warehouse_id: string | null;
  source_warehouse_code: string | null; // hub que surte (si via=transfer)
  cadence_days: number | null;
  health_band: CadenceBand | null;
  last_delivery_date: string | null;
  next_due_date: string | null;
  days_to_due: number | null;            // <0 vencido · 0 hoy · >0 futuro
  lead_time_days: number | null;
  n_skus: number;
  n_below: number;                       // SKUs ≤ punto de reorden
  suggested_qty: number;                 // piezas (horizonte = cadencia+lead+colchón)
  suggested_cost: number;
}
export interface WorklistResponse {
  total: number; vencidos: number; hoy: number; prox7: number;
  page: number; pageSize: number; rows: WorklistRow[];
}
export interface WorklistQuery {
  warehouse_ids?: string[]; warehouse_id?: string; via?: string; status?: string; search?: string; target_basis?: string; page?: number; pageSize?: number;
}

// ── RA-PRO — Histórico de compras al proveedor (tamaño típico de orden) ──
export interface OrderHistoryEntry { date: string; amount: number; pz: number; skus: number; }
export interface SupplierOrderHistory {
  supplier_id: string;
  warehouse_id: string | null;
  n_orders: number;
  last: OrderHistoryEntry | null;
  median_amount: number;
  typical_amount: number;   // promedio de las órdenes "reales" (≥ mediana), sin migajas de fill-in
  max_amount: number;
  since: string | null;
  until: string | null;
  recent: OrderHistoryEntry[];
}

// ── Export XLSX de un PEDIDO (cockpit/consolidado) ─────────────────────
/** Línea de un pedido exportable. Campos opcionales: el backend incluye la columna solo si
 * alguna línea la trae (así el cockpit sale rico y la requisición/OC salen limpias). */
export interface PedidoExportLine {
  warehouse_code?: string | null;
  sku?: string | null;
  nombre?: string | null;
  abc_class?: string | null;
  xyz_class?: string | null;
  sales_rank?: number | null;
  monthly_revenue?: number | null;
  on_hand?: number | null;
  in_transit?: number | null;
  hub_on_hand?: number | null;
  reorder_point?: number | null;
  max_stock?: number | null;
  suggested_qty?: number | null;
  uxc?: number | null;
  cajas?: number | null;
  piezas?: number | null;
  received_qty?: number | null;
  unit_cost?: number | null;
  line_cost?: number | null;
  hub_short?: boolean;
}
export interface PedidoExportPayload {
  title?: string | null;
  supplier_name?: string | null;
  warehouse_label?: string | null;
  via?: 'purchase' | 'transfer' | null;
  basis?: string | null;
  source_warehouse_code?: string | null;
  folio?: string | null;
  estado?: string | null;
  multi_warehouse?: boolean;
  lines: PedidoExportLine[];
}

/** Dispara la descarga de un XLSX recibido como blob (respeta el filename del Content-Disposition). */
export function saveXlsxResponse(resp: HttpResponse<Blob>, fallback = 'reporte.xlsx'): void {
  const blob = resp.body!;
  const cd = resp.headers.get('content-disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  const name = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : fallback);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

@Injectable({ providedIn: 'root' })
export class ComprasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/replenishment`;

  criticalStock(q: CriticalStockQuery): Observable<CriticalStockResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.abc) p.set('abc', q.abc);
    if (q.xyz) p.set('xyz', q.xyz);
    if (q.bucket) p.set('bucket', q.bucket);
    if (q.source) p.set('source', q.source);
    if (q.search) p.set('search', q.search);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    if (q.scope) p.set('scope', q.scope);
    if (q.sort_by) p.set('sort_by', q.sort_by);
    if (q.sort_dir) p.set('sort_dir', q.sort_dir);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<CriticalStockResponse>(`${this.base}/critical-stock${qs ? '?' + qs : ''}`);
  }

  /** Export XLSX con diseño (mismos filtros; exporta TODO el filtro, sin paginar). */
  criticalStockXlsx(q: CriticalStockQuery) {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.abc) p.set('abc', q.abc);
    if (q.xyz) p.set('xyz', q.xyz);
    if (q.bucket) p.set('bucket', q.bucket);
    if (q.source) p.set('source', q.source);
    if (q.search) p.set('search', q.search);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    if (q.scope) p.set('scope', q.scope);
    if (q.sort_by) p.set('sort_by', q.sort_by);
    if (q.sort_dir) p.set('sort_dir', q.sort_dir);
    const qs = p.toString();
    return this.http.get(`${this.base}/critical-stock.xlsx${qs ? '?' + qs : ''}`, {
      responseType: 'blob',
      observe: 'response',
    });
  }

  /** Export XLSX con diseño de un PEDIDO armado en el cliente (cockpit / consolidado). */
  exportPedidoXlsx(payload: PedidoExportPayload) {
    return this.http.post(`${this.base}/pedido.xlsx`, payload, { responseType: 'blob', observe: 'response' });
  }
  /** Export XLSX con diseño de una requisición ya creada (por id). */
  exportRequisitionXlsx(id: string) {
    return this.http.get(`${this.base}/requisitions/${id}/export.xlsx`, { responseType: 'blob', observe: 'response' });
  }

  deadStock(q: { warehouse_ids?: string[]; warehouse_id?: string; supplier_id?: string; search?: string; page?: number; pageSize?: number }): Observable<DeadStockResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.search) p.set('search', q.search);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<DeadStockResponse>(`${this.base}/dead-stock${qs ? '?' + qs : ''}`);
  }

  summary(q: { warehouse_id?: string; warehouse_ids?: string[]; supplier_id?: string; target_basis?: string }): Observable<ReplenishmentSummary> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    const qs = p.toString();
    return this.http.get<ReplenishmentSummary>(`${this.base}/critical-stock/summary${qs ? '?' + qs : ''}`);
  }

  filters(): Observable<ReplenishmentFilters> {
    return this.http.get<ReplenishmentFilters>(`${this.base}/filters`);
  }

  listRequisitions(q?: { estado?: string; warehouse_id?: string; page?: number; pageSize?: number }): Observable<{ total: number; page: number; pageSize: number; rows: RequisitionRow[] }> {
    const p = new URLSearchParams();
    if (q?.estado) p.set('estado', q.estado);
    if (q?.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q?.page) p.set('page', String(q.page));
    if (q?.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<{ total: number; page: number; pageSize: number; rows: RequisitionRow[] }>(`${this.base}/requisitions${qs ? '?' + qs : ''}`);
  }

  getRequisition(id: string): Observable<RequisitionDetail> {
    return this.http.get<RequisitionDetail>(`${this.base}/requisitions/${id}`);
  }
  createRequisition(dto: CreateRequisitionDto): Observable<{ id: string; folio: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; folio: string; estado: RequisitionEstado }>(`${this.base}/requisitions`, dto);
  }
  approve(id: string): Observable<{ id: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; estado: RequisitionEstado }>(`${this.base}/requisitions/${id}/approve`, {});
  }
  reject(id: string): Observable<{ id: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; estado: RequisitionEstado }>(`${this.base}/requisitions/${id}/reject`, {});
  }
  /** RA.14 — approved → ordered (OC emitida / en tránsito). */
  markOrdered(id: string): Observable<{ id: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; estado: RequisitionEstado }>(`${this.base}/requisitions/${id}/order`, {});
  }
  /** RA.14 — ordered → received (+ cantidades recibidas por línea). */
  markReceived(id: string, lines?: ReceiveLine[]): Observable<{ id: string; estado: RequisitionEstado }> {
    return this.http.post<{ id: string; estado: RequisitionEstado }>(`${this.base}/requisitions/${id}/receive`, { lines });
  }
  /** RA.13a — captura del pedido mínimo del proveedor en cajas. */
  setSupplierMinBoxes(supplierId: string, boxes: number | null): Observable<{ id: string; min_order_boxes: number | null }> {
    return this.http.post<{ id: string; min_order_boxes: number | null }>(`${this.base}/suppliers/${supplierId}/min-boxes`, { boxes });
  }

  /** RA-PRO.3 — parámetros de compra por proveedor. */
  listSuppliers(search?: string): Observable<SupplierParam[]> {
    const qs = search ? `?search=${encodeURIComponent(search)}` : '';
    return this.http.get<SupplierParam[]>(`${this.base}/suppliers${qs}`);
  }
  setSupplierLeadTime(supplierId: string, days: number | null): Observable<{ id: string; lead_time_days: number | null }> {
    return this.http.post<{ id: string; lead_time_days: number | null }>(`${this.base}/suppliers/${supplierId}/lead-time`, { days });
  }
  /** RA-PRO.10 — parámetros de pedido (cadencia override + colchón + mínimo $/cajas). */
  setSupplierOrderParams(supplierId: string, patch: SupplierOrderParamsDto): Observable<{ id: string }> {
    return this.http.post<{ id: string }>(`${this.base}/suppliers/${supplierId}/order-params`, patch);
  }
  /** RA-PRO.10 — pedido consolidado al proveedor (cadencia+colchón, subido al mínimo). */
  supplierOrder(supplierId: string): Observable<SupplierOrder> {
    return this.http.get<SupplierOrder>(`${this.base}/suppliers/${supplierId}/order`);
  }

  /** RA-PRO.6 — topología de red de abasto (DRP CEDIS→sucursal). */
  networkTopology(): Observable<NetworkNode[]> {
    return this.http.get<NetworkNode[]>(`${this.base}/network`);
  }
  setWarehouseSource(warehouseId: string, sourceId: string | null): Observable<{ id: string; source_warehouse_id: string | null }> {
    return this.http.post<{ id: string; source_warehouse_id: string | null }>(`${this.base}/warehouses/${warehouseId}/source`, { source_warehouse_id: sourceId });
  }

  /** RA.8 — bandeja de hallazgos de reabastecimiento. */
  findings(q?: { status?: string; kind?: string; warehouse_id?: string; page?: number; pageSize?: number }): Observable<{ total: number; page: number; pageSize: number; status: string; rows: ReplenishmentFinding[] }> {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    if (q?.kind) p.set('kind', q.kind);
    if (q?.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q?.page) p.set('page', String(q.page));
    if (q?.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<{ total: number; page: number; pageSize: number; status: string; rows: ReplenishmentFinding[] }>(`${this.base}/findings${qs ? '?' + qs : ''}`);
  }
  scanNow(): Observable<{ findings: number }> {
    return this.http.post<{ findings: number }>(`${this.base}/scan-now`, {});
  }

  /** RA-PRO.8 — worklist "qué toca": ciclos de reabasto por almacén×proveedor. */
  worklist(q: WorklistQuery): Observable<WorklistResponse> {
    const p = new URLSearchParams();
    if (q.warehouse_ids?.length) p.set('warehouse_ids', q.warehouse_ids.join(','));
    else if (q.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q.via) p.set('via', q.via);
    if (q.status) p.set('status', q.status);
    if (q.search) p.set('search', q.search);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<WorklistResponse>(`${this.base}/worklist${qs ? '?' + qs : ''}`);
  }

  /** RA-PRO — histórico de compras al proveedor (tamaño típico de orden). warehouse_id opcional (el de compra; para traspasos, el hub). */
  supplierOrderHistory(supplierId: string, warehouseId?: string): Observable<SupplierOrderHistory> {
    const qs = warehouseId ? `?warehouse_id=${encodeURIComponent(warehouseId)}` : '';
    return this.http.get<SupplierOrderHistory>(`${this.base}/suppliers/${supplierId}/order-history${qs}`);
  }

  // ── RA.15 (ADR-031) — Órdenes de compra (OC) + recepción (OE) ─────────
  private readonly poBase = `${environment.apiUrl}/commercial/purchase-orders`;

  listPurchaseOrders(q?: { estado?: string; supplier_id?: string; warehouse_id?: string; page?: number; pageSize?: number }): Observable<{ total: number; page: number; pageSize: number; rows: PurchaseOrderRow[] }> {
    const p = new URLSearchParams();
    if (q?.estado) p.set('estado', q.estado);
    if (q?.supplier_id) p.set('supplier_id', q.supplier_id);
    if (q?.warehouse_id) p.set('warehouse_id', q.warehouse_id);
    if (q?.page) p.set('page', String(q.page));
    if (q?.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<{ total: number; page: number; pageSize: number; rows: PurchaseOrderRow[] }>(`${this.poBase}${qs ? '?' + qs : ''}`);
  }
  getPurchaseOrder(id: string): Observable<PurchaseOrderDetail> {
    return this.http.get<PurchaseOrderDetail>(`${this.poBase}/${id}`);
  }
  /** Export XLSX con diseño de una orden de compra (por id). */
  exportPurchaseOrderXlsx(id: string) {
    return this.http.get(`${this.poBase}/${id}/export.xlsx`, { responseType: 'blob', observe: 'response' });
  }
  /** Genera la OC desde una requisición aprobada. */
  createPOFromRequisition(requisitionId: string, body?: { expected_date?: string | null; notes?: string }): Observable<{ id: string; folio: string; estado: PurchaseOrderEstado; requisition_folio: string }> {
    return this.http.post<{ id: string; folio: string; estado: PurchaseOrderEstado; requisition_folio: string }>(`${this.poBase}/from-requisition/${requisitionId}`, body ?? {});
  }
  cancelPurchaseOrder(id: string): Observable<{ id: string; estado: PurchaseOrderEstado }> {
    return this.http.post<{ id: string; estado: PurchaseOrderEstado }>(`${this.poBase}/${id}/cancel`, {});
  }
  /** OE — registra una recepción (parcial permitido); mueve stock. */
  createReceipt(poId: string, dto: { lines: CreateReceiptLine[]; notes?: string; received_at?: string | null }): Observable<{ id: string; folio: string; po_estado: PurchaseOrderEstado; total_units: number; total_cost: number; stock_applied: boolean }> {
    return this.http.post<{ id: string; folio: string; po_estado: PurchaseOrderEstado; total_units: number; total_cost: number; stock_applied: boolean }>(`${this.poBase}/${poId}/receipts`, dto);
  }
}
