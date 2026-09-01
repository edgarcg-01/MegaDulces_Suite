import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export type HealthStatus = 'ok' | 'warn' | 'critical' | 'unknown';

export interface SourceHealth {
  group: 'app' | 'source' | 'cron';
  key: string;
  label: string;
  table: string;
  ts_col: string | null;
  last_update: string | null;
  age_seconds: number | null;
  status: HealthStatus;
  cadence: string;
  rows: number | null;
  note?: string;
}

export interface DbHealthReport {
  checked_at: string;
  db_label: string;
  overall: HealthStatus;
  sources: SourceHealth[];
}

export interface HealthAlert {
  id: string;
  source_key: string;
  source_label: string;
  group_key: string | null;
  status: 'warn' | 'critical';
  age_seconds: number | null;
  last_update: string | null;
  note: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  acknowledged_at: string | null;
}

export interface HealthAlertsResponse {
  open: HealthAlert[];
  recent_resolved: HealthAlert[];
}

// DBH.1 — salud del MOTOR. Distinta del reporte de frescura: aquello responde "¿llegó el dato?",
// esto "¿cómo está la base?". Magnitudes (%, MB, conexiones, segundos), no edades.
export interface EngineTable {
  schema: string; table: string; live: number; dead: number; dead_pct: number | null;
  last_autovacuum: string | null; last_autoanalyze: string | null;
  size_bytes: number; size_pretty: string; status: HealthStatus;
}

export interface EngineMetric {
  key: string; label: string; display: string; status: HealthStatus; note?: string;
}

export interface EngineReport {
  checked_at: string; db_label: string; overall: HealthStatus;
  database: { name: string; size_pretty: string; version: string };
  metrics: EngineMetric[];
  bloat: EngineTable[];
  schemas: { schema: string; size_pretty: string; tables: number }[];
  autovacuum: { name: string; setting: string }[];
}

@Injectable({ providedIn: 'root' })
export class DbHealthService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/admin/db-health`;

  getReport(): Observable<DbHealthReport> {
    return this.http.get<DbHealthReport>(this.apiUrl);
  }

  getEngine(): Observable<EngineReport> {
    return this.http.get<EngineReport>(`${this.apiUrl}/engine`);
  }

  listAlerts(): Observable<HealthAlertsResponse> {
    return this.http.get<HealthAlertsResponse>(`${this.apiUrl}/alerts`);
  }

  ackAlert(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.apiUrl}/alerts/${id}/ack`, {});
  }

  scanNow(): Observable<{ opened: number; escalated: number; resolved: number; failing: number }> {
    return this.http.post<{ opened: number; escalated: number; resolved: number; failing: number }>(`${this.apiUrl}/scan-now`, {});
  }
}
