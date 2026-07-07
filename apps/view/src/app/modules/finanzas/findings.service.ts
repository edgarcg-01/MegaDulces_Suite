import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** MAAT.2 — cliente de la bandeja de hallazgos del motor de patrones. */

export type FindingClase = 'riesgo' | 'error_captura' | 'oportunidad';
export type FindingSeverity = 'info' | 'warn' | 'critical';
export type FindingStatus = 'nuevo' | 'en_revision' | 'confirmado' | 'descartado' | 'corregido';
export type FindingVerdict = 'util' | 'falso' | 'duplicado' | 'ya_corregido';

export interface Finding {
  id: string;
  rule_key: string;
  regla: string | null;
  clase: FindingClase;
  severity: FindingSeverity;
  status: FindingStatus;
  score: number | null;
  titulo: string;
  resumen: string;
  entity: Record<string, any> | null;
  periodo: string | null;
  importe: number;
  evidencia: Record<string, any> | null;
  first_seen: string;
  last_seen: string;
}

export interface FindingsStats {
  pendientes: number;
  criticos: number;
  monto_en_riesgo: number;
  por_clase: { clase: FindingClase; n: number }[];
}

export interface RuleHealth {
  rule_key: string;
  nombre: string;
  clase: FindingClase;
  enabled: boolean;
  pinned: boolean;
  suppressed_auto: boolean;
  precision_score: number | null;
  findings_total: number;
  findings_confirmados: number;
  findings_falsos: number;
}

@Injectable({ providedIn: 'root' })
export class FindingsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/maat/findings`;

  list(q?: { status?: string; clase?: string; severity?: string; rule_key?: string; limit?: number }): Observable<Finding[]> {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    if (q?.clase) p.set('clase', q.clase);
    if (q?.severity) p.set('severity', q.severity);
    if (q?.rule_key) p.set('rule_key', q.rule_key);
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<Finding[]>(`${this.base}${qs ? '?' + qs : ''}`);
  }

  stats(): Observable<FindingsStats> { return this.http.get<FindingsStats>(`${this.base}/stats`); }
  rules(): Observable<RuleHealth[]> { return this.http.get<RuleHealth[]>(`${this.base}/rules`); }

  setStatus(id: string, status: FindingStatus): Observable<any> {
    return this.http.patch(`${this.base}/${id}/status`, { status });
  }
  feedback(id: string, verdict: FindingVerdict, nota?: string): Observable<any> {
    return this.http.post(`${this.base}/${id}/feedback`, { verdict, nota });
  }
  pinRule(ruleKey: string, pinned: boolean): Observable<any> {
    return this.http.post(`${this.base}/rules/${ruleKey}/pin`, { pinned });
  }
  scan(): Observable<{ nuevos: number; reglas: number; por_regla: any[] }> {
    return this.http.post<{ nuevos: number; reglas: number; por_regla: any[] }>(`${this.base}/scan`, {});
  }
}
