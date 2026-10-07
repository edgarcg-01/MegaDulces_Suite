import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase PREV.1 — Prevención de Inventarios (expediente de investigación).
 * Consume `/commercial/inventory/investigations/*`.
 */

export type InvestigationStatus = 'open' | 'investigating' | 'resolved' | 'monitoring';
export type RootCause = 'EC' | 'ER' | 'EA' | 'DC' | 'DP' | 'TR' | 'UB' | 'MR' | 'PNI';

export interface Investigation {
  id: string;
  folio: string;
  warehouse_id: string;
  warehouse_code?: string;
  warehouse_name?: string;
  product_id: string;
  sku?: string | null;
  product_name?: string | null;
  expected_qty: number;
  physical_qty: number;
  difference: number;
  unit_cost?: number;
  value_at_cost: number;
  status: InvestigationStatus;
  root_cause?: RootCause | null;
  reason_code?: string | null;
  resolution_notes?: string | null;
  adjustment_movement_id?: string | null;
  opened_at?: string;
  resolved_at?: string | null;
  source_count_id?: string | null;
}

export interface TimelineEvent {
  source: 'app' | 'erp';
  ts: string;
  kind: string;
  signed_qty: number | null;
  quantity: number;
  quantity_after?: number | null;
  reference_type?: string | null;
  reference_id?: string | null;
  folio?: string | null;
  detail?: string | null;
}

export interface InvestigationDetail extends Investigation {
  timeline: TimelineEvent[];
}

@Injectable({ providedIn: 'root' })
export class PrevencionService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/inventory/investigations`;

  list(filters: { status?: string; warehouse_id?: string; product_id?: string; limit?: number } = {}): Observable<Investigation[]> {
    let params = new HttpParams();
    if (filters.status) params = params.set('status', filters.status);
    if (filters.warehouse_id) params = params.set('warehouse_id', filters.warehouse_id);
    if (filters.product_id) params = params.set('product_id', filters.product_id);
    if (filters.limit) params = params.set('limit', String(filters.limit));
    return this.http.get<Investigation[]>(this.base, { params });
  }

  detail(id: string): Observable<InvestigationDetail> {
    return this.http.get<InvestigationDetail>(`${this.base}/${id}`);
  }

  open(dto: { warehouse_id: string; product_id: string; expected_qty: number; physical_qty: number; unit_cost?: number; reason_code?: string; notes?: string }): Observable<Investigation> {
    return this.http.post<Investigation>(this.base, dto);
  }

  fromCount(count: string): Observable<{ count_folio: string; created: number; folios: string[] }> {
    return this.http.post<{ count_folio: string; created: number; folios: string[] }>(`${this.base}/from-count`, { count });
  }

  classify(id: string, root_cause: RootCause, notes?: string): Observable<InvestigationDetail> {
    return this.http.post<InvestigationDetail>(`${this.base}/${id}/classify`, { root_cause, notes });
  }

  resolve(id: string, dto: { root_cause?: RootCause; resolution_notes?: string; adjustment_movement_id?: string }): Observable<InvestigationDetail> {
    return this.http.post<InvestigationDetail>(`${this.base}/${id}/resolve`, dto);
  }

  toMonitoring(id: string): Observable<InvestigationDetail> {
    return this.http.post<InvestigationDetail>(`${this.base}/${id}/monitoring`, {});
  }
}
