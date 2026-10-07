import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FD.2 — cliente del tablero de Diagnóstico de facturación. /fiscal/diagnostics. Operations. */

export type EmissionErrorKind = 'timbrado' | 'nota_credito' | 'rep' | 'cancelacion';

export interface SatErrorSolution {
  code?: string;
  titulo: string;
  causa: string;
  solucion: string;
  deep_link?: string;
  fix_label?: string;
  severity?: 'critical' | 'warn' | 'info';
}

export interface DiagnosticRow {
  id: string;
  kind: EmissionErrorKind;
  status: string;
  order_id: string | null;
  cfdi_uuid: string | null;
  receptor_rfc: string | null;
  receptor_nombre: string | null;
  serie: string | null;
  folio: string | null;
  total: string | number | null;
  http_status: number | null;
  pac_code: string | null;
  error_message: string | null;
  error_detail: string | null;
  attempts: number;
  first_seen_at: string;
  last_seen_at: string;
  solucion: SatErrorSolution;
  can_retry_order: boolean;
}

export interface DiagnosticStats {
  open_total: number;
  criticos: number;
  por_tipo: { kind: EmissionErrorKind; count: number }[];
  por_severidad: { severity: string; count: number }[];
}

export interface HealthCheck {
  key: string;
  status: 'ok' | 'warn' | 'critical';
  titulo: string;
  detalle: string;
  solucion?: string;
  deep_link?: string;
  fix_label?: string;
}

@Injectable({ providedIn: 'root' })
export class DiagnosticoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/diagnostics`;

  list(q: { status?: 'open' | 'resolved' | 'all'; kind?: EmissionErrorKind } = {}): Observable<DiagnosticRow[]> {
    let params = new HttpParams();
    if (q.status) params = params.set('status', q.status);
    if (q.kind) params = params.set('kind', q.kind);
    return this.http.get<DiagnosticRow[]>(this.base, { params });
  }
  stats(): Observable<DiagnosticStats> { return this.http.get<DiagnosticStats>(`${this.base}/stats`); }
  health(): Observable<HealthCheck[]> { return this.http.get<HealthCheck[]>(`${this.base}/health`); }
  catalog(): Observable<SatErrorSolution[]> { return this.http.get<SatErrorSolution[]>(`${this.base}/catalog`); }
  detail(id: string): Observable<DiagnosticRow & { pac_raw: unknown }> {
    return this.http.get<DiagnosticRow & { pac_raw: unknown }>(`${this.base}/${id}`);
  }
  dismiss(id: string): Observable<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`${this.base}/${id}/dismiss`, {});
  }
}
