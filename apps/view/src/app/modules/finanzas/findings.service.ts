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

/** MIQ.3 — cobertura por categoría de riesgo + puntos ciegos. */
export interface Coverage {
  categorias: { key: string; nombre: string; critica: boolean; rules: string[]; registrados: number; activos: number; suprimidos: number; findings: number }[];
  total_categorias: number; puntos_ciegos: string[]; cobertura_pct: number;
}
/** MIQ.3 — índice de calidad de los feeds. */
export interface DataQuality {
  indice_global: number; semaforo: 'verde' | 'amarillo' | 'rojo';
  dimensiones: { key: string; nombre: string; score: number; pct_malo: number; n: number; importe: number; detalle: string }[];
}
/** MIQ.4 — hipótesis de detector propuesta (HITL). */
export interface Hypothesis {
  id: string; source: 'deterministic' | 'ai'; titulo: string; descripcion: string;
  clase: FindingClase; score: number | null; status: string; evidencia: Record<string, any> | null; created_at: string;
}
/** MIQ.2 — estado del modelo que aprende. */
export interface ModelStatus {
  modelo: { version: number; algo: string; n_train: number; n_pos: number; trained_at: string; metrics: Record<string, any> } | null;
  dataset: { total: number; etiquetados: number; positivos: number; scoreados: number };
  listo_para_entrenar: boolean;
}
/** MIQ.6 — backtest time-split. */
export interface Backtest {
  ran: boolean; reason?: string; n_labeled?: number; base_rate?: number;
  model?: { auc: number; precision: number; recall: number; f1: number };
  baseline_detector?: { auc: number }; lift_auc?: number; veredicto?: string;
}
/** MIQ.2 — hallazgo con incertidumbre alta (active learning). */
export interface UncertainRow { id: string; rule_key: string; titulo: string; severity: FindingSeverity; clase: FindingClase; importe: number; model_score: number; }

@Injectable({ providedIn: 'root' })
export class FindingsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/maat/findings`;
  private readonly maatBase = `${environment.apiUrl}/finance/maat`;

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

  // ── MIQ.3 cobertura + calidad de datos ──
  coverage(): Observable<Coverage> { return this.http.get<Coverage>(`${this.base}/coverage`); }
  dataQuality(): Observable<DataQuality> { return this.http.get<DataQuality>(`${this.base}/data-quality`); }

  // ── MIQ.4 descubrimiento de detectores (HITL) + escéptico ──
  discovery(status = 'propuesta'): Observable<Hypothesis[]> { return this.http.get<Hypothesis[]>(`${this.maatBase}/discovery?status=${status}`); }
  runDiscovery(): Observable<{ deterministas: number; ai: number; total: number }> { return this.http.post<{ deterministas: number; ai: number; total: number }>(`${this.maatBase}/discovery/run`, {}); }
  approveHypothesis(id: string): Observable<any> { return this.http.post(`${this.maatBase}/discovery/${id}/approve`, {}); }
  rejectHypothesis(id: string): Observable<any> { return this.http.post(`${this.maatBase}/discovery/${id}/reject`, {}); }
  skepticRun(): Observable<{ revisados: number; refutado: number; debil: number; sostiene: number }> { return this.http.post<{ revisados: number; refutado: number; debil: number; sostiene: number }>(`${this.maatBase}/skeptic/run`, {}); }

  // ── MIQ.2/6 modelo que aprende + backtest ──
  learningStatus(): Observable<ModelStatus> { return this.http.get<ModelStatus>(`${this.maatBase}/learning/status`); }
  backtest(): Observable<Backtest> { return this.http.get<Backtest>(`${this.maatBase}/learning/backtest`); }
  uncertain(limit = 15): Observable<UncertainRow[]> { return this.http.get<UncertainRow[]>(`${this.maatBase}/learning/uncertain?limit=${limit}`); }
  runLearning(): Observable<any> { return this.http.post(`${this.maatBase}/learning/run`, {}); }
}
