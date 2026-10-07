import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Fase CT (Track A) — cliente de la pista de razonamiento de Thot (ADR-018/016):
 * hallazgos → diagnósticos → acciones co-piloto → autonomía → aprendizaje.
 * Superficie que hasta ahora vivía sólo en la API (`/commercial/intelligence/*`).
 * El motor decide de forma determinista; aquí el humano revisa y aprueba (HITL).
 */

export type FindingStatus = 'open' | 'confirmed' | 'dismissed' | 'resolved';
export interface CommercialFinding {
  id: string;
  finding_type: string;          // low_rotation_priced | margin_laggard | distribution_gap | churn_risk
  severity: string;              // critica | alta | media (u otro)
  subject_type: string;          // product | customer | zone…
  subject_id: string | null;
  label: string;
  score: number | null;
  evidence: Record<string, unknown> | null;
  explanation: string | null;
  source: string | null;
  status: FindingStatus;
  created_at: string;
}
export interface CommercialDiagnosis {
  id: string;
  root_cause: string;
  severity: string;
  subject_type: string;
  label: string;
  finding_types: string[] | null;
  confidence: number | null;
  summary: string | null;
  status: string;
  created_at: string;
}
export interface CommercialAction {
  id: string;
  kind: string;                  // finding | diagnosis
  action_type: string;           // push_product | coaching | …
  subject_type: string;
  label: string;
  title: string | null;
  rationale: string | null;
  confidence: number | null;
  expected_impact: string | null;
  priority: number | null;
  root_cause: string | null;
  status: string;                // pending_approval | approved | rejected | executed
  auto_executed: boolean;
  created_at: string;
}
export interface ActionExplain {
  chain?: unknown;
  narrative?: string;
  [k: string]: unknown;
}
export interface RuleStat {
  finding_type: string;
  n_total: number;
  reviewed_total: number;
  n_confirmed: number;
  n_dismissed: number;
  precision: number | null;
  floor_met: boolean;
  auto_suppressed: boolean;
  manual_override: string | null;
  weight: number | null;
}
export interface AutonomyPolicy {
  action_type: string;
  mode: 'off' | 'dry_run' | 'auto';
  min_confidence: number | null;
  daily_cap: number | null;
  value_cap_mxn: number | null;
}

@Injectable({ providedIn: 'root' })
export class CommercialIntelligenceService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/intelligence`;

  // ── Hallazgos (T.R0) ──
  findings(q: { status?: string; severity?: string; subject_type?: string } = {}): Observable<CommercialFinding[]> {
    const params: Record<string, string> = {};
    if (q.status) params['status'] = q.status;
    if (q.severity) params['severity'] = q.severity;
    if (q.subject_type) params['subject_type'] = q.subject_type;
    return this.http.get<CommercialFinding[]>(`${this.base}/findings`, { params });
  }
  computeFindings(): Observable<{ findings?: number } & Record<string, unknown>> {
    return this.http.post<{ findings?: number }>(`${this.base}/findings/compute`, {});
  }
  reviewFinding(id: string, status: string): Observable<unknown> {
    return this.http.post(`${this.base}/findings/${id}/review`, { status });
  }

  // ── Diagnósticos (T.R1) ──
  diagnoses(status?: string): Observable<CommercialDiagnosis[]> {
    return this.http.get<CommercialDiagnosis[]>(`${this.base}/diagnoses`, { params: status ? { status } : {} });
  }
  computeDiagnoses(): Observable<unknown> { return this.http.post(`${this.base}/diagnoses/compute`, {}); }
  reviewDiagnosis(id: string, status: string): Observable<unknown> {
    return this.http.post(`${this.base}/diagnoses/${id}/review`, { status });
  }

  // ── Acciones co-piloto (T.R2 / HITL) ──
  actions(q: { status?: string; kind?: string } = {}): Observable<CommercialAction[]> {
    const params: Record<string, string> = {};
    if (q.status) params['status'] = q.status;
    if (q.kind) params['kind'] = q.kind;
    return this.http.get<CommercialAction[]>(`${this.base}/actions`, { params });
  }
  computeActions(): Observable<unknown> { return this.http.post(`${this.base}/actions/compute`, {}); }
  explainAction(id: string): Observable<ActionExplain> { return this.http.get<ActionExplain>(`${this.base}/actions/${id}/explain`); }
  approveAction(id: string): Observable<unknown> { return this.http.post(`${this.base}/actions/${id}/approve`, {}); }
  rejectAction(id: string): Observable<unknown> { return this.http.post(`${this.base}/actions/${id}/reject`, {}); }

  // ── Aprendizaje (T.L2) ──
  learningRules(): Observable<RuleStat[]> { return this.http.get<RuleStat[]>(`${this.base}/learning/rules`); }
  recomputeLearning(): Observable<unknown> { return this.http.post(`${this.base}/learning/recompute`, {}); }
  overrideRule(findingType: string, override: string | null): Observable<unknown> {
    return this.http.post(`${this.base}/learning/rules/${findingType}/override`, { override });
  }

  // ── Autonomía (ADR-023) ──
  autonomyPolicies(): Observable<AutonomyPolicy[]> { return this.http.get<AutonomyPolicy[]>(`${this.base}/autonomy/policies`); }
  setAutonomyPolicy(actionType: string, patch: Partial<AutonomyPolicy>): Observable<unknown> {
    return this.http.patch(`${this.base}/autonomy/policies/${actionType}`, patch);
  }
  runAutonomy(): Observable<unknown> { return this.http.post(`${this.base}/autonomy/run`, {}); }
  autonomyLog(): Observable<CommercialAction[]> { return this.http.get<CommercialAction[]>(`${this.base}/autonomy/log`); }
}
