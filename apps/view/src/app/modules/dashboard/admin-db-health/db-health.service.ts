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

@Injectable({ providedIn: 'root' })
export class DbHealthService {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/admin/db-health`;

  getReport(): Observable<DbHealthReport> {
    return this.http.get<DbHealthReport>(this.apiUrl);
  }
}
