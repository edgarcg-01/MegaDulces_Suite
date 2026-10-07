import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase PREV.3 — Índice de riesgo de inventario.
 * Consume `/commercial/inventory/risk`.
 */

export interface RiskRow {
  id: string;
  warehouse_id: string;
  warehouse_code?: string;
  product_id: string;
  sku?: string | null;
  product_name?: string | null;
  investigations_count: number;
  pni_count: number;
  monitoring_losses: number;
  shrink_value: number;
  risk_score: number;
  risk_level: 'bajo' | 'medio' | 'alto' | 'critico';
  last_event_at?: string | null;
  computed_at?: string;
}

@Injectable({ providedIn: 'root' })
export class RiesgoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/inventory/risk`;

  list(filters: { risk_level?: string; warehouse_id?: string; limit?: number } = {}): Observable<RiskRow[]> {
    let params = new HttpParams();
    if (filters.risk_level) params = params.set('risk_level', filters.risk_level);
    if (filters.warehouse_id) params = params.set('warehouse_id', filters.warehouse_id);
    if (filters.limit) params = params.set('limit', String(filters.limit));
    return this.http.get<RiskRow[]>(this.base, { params });
  }

  compute(warehouse_id?: string): Observable<{ computed: number }> {
    return this.http.post<{ computed: number }>(`${this.base}/compute`, { warehouse_id });
  }
}
