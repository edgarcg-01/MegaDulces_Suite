import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase PREV.2 — Monitoreo intensivo de inventario.
 * Consume `/commercial/inventory/monitoring/*`.
 */

export interface Monitoring {
  id: string;
  warehouse_id: string;
  warehouse_code?: string;
  product_id: string;
  sku?: string | null;
  product_name?: string | null;
  status: 'active' | 'closed';
  counts_per_day: number;
  reason?: string | null;
  started_at?: string;
  source_investigation_id?: string | null;
  counts_today?: string | number;
  last_difference?: string | number | null;
  last_count_at?: string | null;
}

export interface MonitoringCount {
  id: string;
  expected_qty: number;
  physical_qty: number;
  difference: number;
  window_from: string | null;
  window_to: string;
  counted_at: string;
  counted_by?: string | null;
  notes?: string | null;
}

export interface MonitoringDetail extends Monitoring {
  warehouse_name?: string;
  counts: MonitoringCount[];
}

@Injectable({ providedIn: 'root' })
export class MonitoreoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/inventory/monitoring`;

  start(dto: { warehouse_id: string; product_id: string; source_investigation_id?: string; reason?: string; counts_per_day?: number }): Observable<Monitoring> {
    return this.http.post<Monitoring>(this.base, dto);
  }

  list(filters: { status?: string; warehouse_id?: string; limit?: number } = {}): Observable<Monitoring[]> {
    let params = new HttpParams();
    if (filters.status) params = params.set('status', filters.status);
    if (filters.warehouse_id) params = params.set('warehouse_id', filters.warehouse_id);
    if (filters.limit) params = params.set('limit', String(filters.limit));
    return this.http.get<Monitoring[]>(this.base, { params });
  }

  detail(id: string): Observable<MonitoringDetail> {
    return this.http.get<MonitoringDetail>(`${this.base}/${id}`);
  }

  recordCount(id: string, dto: { physical_qty: number; notes?: string }): Observable<MonitoringCount> {
    return this.http.post<MonitoringCount>(`${this.base}/${id}/count`, dto);
  }

  close(id: string): Observable<MonitoringDetail> {
    return this.http.post<MonitoringDetail>(`${this.base}/${id}/close`, {});
  }
}
