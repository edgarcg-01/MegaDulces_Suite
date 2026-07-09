import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** Fase RA (ADR-030) — cliente del proyecto Compras: existencia crítica + requisiciones. */

export type TargetBasis = 'min' | 'reorder' | 'max';
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
  supplier_min_boxes: number | null; // RA.13a — pedido mínimo del proveedor en cajas
  factor_purchase: number | null;    // piezas por caja (para convertir piezas→cajas)
  abc_class: string | null;
  unit_cost: number | null;
  bucket: Bucket;
  suggested_qty: number;
  suggested_cost: number;
}
export interface CriticalStockResponse {
  total: number;
  page: number;
  pageSize: number;
  target_basis: TargetBasis;
  rows: CriticalStockRow[];
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
  bucket?: string;
  source?: string;
  search?: string;
  target_basis?: string;
  scope?: string;
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

export type FindingKind = 'agotado_abc' | 'bajo_reorden';
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
    if (q.bucket) p.set('bucket', q.bucket);
    if (q.source) p.set('source', q.source);
    if (q.search) p.set('search', q.search);
    if (q.target_basis) p.set('target_basis', q.target_basis);
    if (q.scope) p.set('scope', q.scope);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return this.http.get<CriticalStockResponse>(`${this.base}/critical-stock${qs ? '?' + qs : ''}`);
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
}
