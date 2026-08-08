import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Análisis semanal de Tienda. Pega a `/store/analytics/weekly` — scopeado por la
 * sucursal del usuario en el backend. Datos agregados on-the-fly (sin feeds nuevos).
 */
export interface WeeklyKpi { cur: number; prev: number; delta_pct: number | null; }
export interface WeeklySeriesPoint { week_start: string; label: string; revenue: number; margin: number; units: number; }
export interface WeeklyBranchRow {
  code: string; name: string; revenue: number; revenue_prev: number; revenue_delta_pct: number | null;
  margin: number; units: number; units_prev: number; units_delta_pct: number | null;
}
export interface WeeklyProductRow {
  product_id: string; sku: string; nombre: string; brand: string | null;
  revenue: number; revenue_prev: number; revenue_delta_pct: number | null; units: number;
}
export interface WeeklyReport {
  ref_week: { start: string; label: string };
  prev_week: { start: string; label: string };
  weeks: number;
  scoped_warehouse: string | null;
  series: WeeklySeriesPoint[];
  kpis: { revenue: WeeklyKpi; margin: WeeklyKpi; units: WeeklyKpi; units_official: WeeklyKpi };
  by_branch: WeeklyBranchRow[];
  by_product: WeeklyProductRow[];
}

/** ST.1 — Análisis por RANGO personalizado (métricas de operación de tienda). */
export interface RangeKpi { cur: number; prev: number; delta_pct: number | null; }
export interface RangeSeriesPoint { date: string; revenue: number; margin: number; units: number; tickets: number; }
export interface RangeBranchRow { code: string; name: string; revenue: number; margin: number; units: number; tickets: number; avg_ticket: number; }
export interface RangeProductRow { product_id: string; sku: string; nombre: string; brand: string | null; revenue: number; margin: number; units: number; }
export interface RangeReport {
  period: { from: string; to: string; days: number };
  prev_period: { from: string; to: string };
  scoped_warehouse: string | null;
  kpis: {
    revenue: RangeKpi; margin: RangeKpi; units: RangeKpi; units_official: RangeKpi;
    tickets: RangeKpi; avg_ticket: RangeKpi; basket: RangeKpi;
  };
  series: RangeSeriesPoint[];
  by_branch: RangeBranchRow[];
  by_product: RangeProductRow[];
}

@Injectable({ providedIn: 'root' })
export class WeeklyService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/analytics`;

  weekly(q?: { week?: string; weeks?: number; warehouse_code?: string }): Observable<WeeklyReport> {
    const p = new URLSearchParams();
    if (q?.week) p.set('week', q.week);
    if (q?.weeks) p.set('weeks', String(q.weeks));
    if (q?.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    const qs = p.toString();
    return this.http.get<WeeklyReport>(`${this.base}/weekly${qs ? '?' + qs : ''}`);
  }

  range(q: { from: string; to: string; warehouse_code?: string }): Observable<RangeReport> {
    const p = new URLSearchParams();
    p.set('from', q.from); p.set('to', q.to);
    if (q.warehouse_code) p.set('warehouse_code', q.warehouse_code);
    return this.http.get<RangeReport>(`${this.base}/range?${p.toString()}`);
  }
}
