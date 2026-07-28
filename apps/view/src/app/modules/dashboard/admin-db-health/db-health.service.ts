import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export type HealthStatus = 'ok' | 'warn' | 'critical' | 'unknown';

export interface SourceHealth {
  group: 'app' | 'source';
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

@Injectable({ providedIn: 'root' })
export class DbHealthService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/admin/db-health`;

  getReport(): Observable<DbHealthReport> {
    return this.http.get<DbHealthReport>(this.apiUrl);
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
