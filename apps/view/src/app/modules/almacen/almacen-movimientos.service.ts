import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * DM — Diario de movimientos (mejora del reporte Kepler). Cliente de
 * /commercial/movements. Agregación primero (summary/aggregate), drill por folio (lines).
 */

export type GroupBy = 'product' | 'doc_code' | 'day' | 'warehouse';
export type MovementKind = 'entrada' | 'salida';

export interface MovementsFilters {
  warehouse_ids?: string[];
  from?: string;
  to?: string;
  doc_code?: string;
  movement_kind?: MovementKind | '';
  search?: string;
}

export interface MovementTotals {
  entradas: number; salidas: number; neto: number; valor: number;
  lineas: number; documentos: number;
}
export interface MovementByType {
  doc_code: string; movement_label: string; movement_kind: MovementKind;
  piezas: number; valor: number; lineas: number;
}
export interface MovementsSummary {
  range: { from: string; to: string };
  totals: MovementTotals;
  by_type: MovementByType[];
}

export interface AggregateRow {
  key: string; label: string; sku?: string; code?: string; movement_kind?: MovementKind;
  entradas: number; salidas: number; neto: number; valor: number | null;
  lineas: number; documentos: number;
}
export interface AggregateResponse {
  group_by: GroupBy; page: number; pageSize: number; total: number; rows: AggregateRow[];
}

export interface MovementLine {
  doc_date: string; folio: string; doc_code: string; movement_label: string;
  movement_kind: MovementKind; genero: string; naturaleza: string; doc_type: string;
  signed_qty: number; qty: number; unit_cost: number | null; amount: number | null;
  parent_group: string | null; parent_folio: string | null; source_branch: string;
  product_name: string | null; sku: string | null; warehouse_code: string | null;
}
export interface LinesResponse { page: number; pageSize: number; total: number; rows: MovementLine[]; }

export interface MovementsFilterOpts {
  warehouses: { id: string; code: string; name: string }[];
  doc_types: { doc_code: string; movement_label: string; movement_kind: MovementKind }[];
}

@Injectable({ providedIn: 'root' })
export class AlmacenMovimientosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/movements`;

  private params(f: MovementsFilters, extra: Record<string, string | number | undefined> = {}): HttpParams {
    let p = new HttpParams();
    if (f.warehouse_ids?.length) p = p.set('warehouse_ids', f.warehouse_ids.join(','));
    if (f.from) p = p.set('from', f.from);
    if (f.to) p = p.set('to', f.to);
    if (f.doc_code) p = p.set('doc_code', f.doc_code);
    if (f.movement_kind) p = p.set('movement_kind', f.movement_kind);
    if (f.search) p = p.set('search', f.search);
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') p = p.set(k, String(v));
    return p;
  }

  summary(f: MovementsFilters): Observable<MovementsSummary> {
    return this.http.get<MovementsSummary>(`${this.base}/summary`, { params: this.params(f) });
  }
  aggregate(f: MovementsFilters, group_by: GroupBy, page: number, pageSize: number): Observable<AggregateResponse> {
    return this.http.get<AggregateResponse>(`${this.base}/aggregate`, { params: this.params(f, { group_by, page, pageSize }) });
  }
  lines(f: MovementsFilters, extra: { product_id?: string; page?: number; pageSize?: number }): Observable<LinesResponse> {
    return this.http.get<LinesResponse>(`${this.base}/lines`, { params: this.params(f, extra) });
  }
  filters(): Observable<MovementsFilterOpts> {
    return this.http.get<MovementsFilterOpts>(`${this.base}/filters`);
  }
}
