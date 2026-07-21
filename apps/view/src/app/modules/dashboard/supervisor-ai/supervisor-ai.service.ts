import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface BriefingComparison {
  yesterday_headline: string | null;
  findings_new_24h: number;
  findings_resolved_24h: number;
  persistent: Array<{ subject: string; type: string; days_open: number }>;
  team_score_now: number | null;
  team_score_week_ago: number | null;
  team_score_delta: number | null;
  outcomes_7d: Array<{ subject: string; action_type: string; verdict: string; delta: number | null }>;
}

export interface BriefingResponse {
  headline: string;
  summary: string;
  attention: Array<{ subject: string; why: string; severity: string }>;
  stats: {
    collaborators: number;
    findings_total: number;
    critical: number;
    warn: number;
    by_type: Record<string, number>;
  };
  comparison?: BriefingComparison;
  source: 'agent' | 'engine';
  generated_at: string;
}

export interface ExecScoreSignal {
  key: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
}

export interface Execution360Row {
  subject_type: 'collaborator' | 'route' | 'store';
  subject_id: string;
  window_days: number;
  label: string | null;
  visits_done: number;
  avg_score: number | null;
  score_trend: number | null;
  own_share_pct: number | null;
  competitor_share_pct: number | null;
  photo_coverage_pct: number | null;
  days_since_last_visit: number | null;
  exec_score?: number | null;
  exec_score_breakdown?: { confidence: number; signals: ExecScoreSignal[] } | null;
  exec_level_score?: number | null;
  avg_visit_min?: number | null;
  avg_skus?: number | null;
  idle_min_avg?: number | null;
  by_concept?: Record<string, { label: string | null; n: number; level_avg: number | null; own_share_pct: number | null; photo_pct: number | null }> | null;
  by_location?: Record<string, { label: string | null; n: number; level_avg: number | null }> | null;
  planogram_present?: number | null;
  planogram_total?: number | null;
  position_quality?: number | null;
}

export interface FindingRow {
  id: string;
  finding_type: string;
  severity: 'info' | 'warn' | 'critical';
  subject_type: string;
  label: string | null;
  score: number | null;
  evidence: Record<string, any>;
  status: string;
  source?: string;
  created_at: string;
}

export interface DiagnosisRow {
  id: string;
  root_cause: string;
  severity: 'info' | 'warn' | 'critical';
  subject_type: string;
  subject_id: string;
  label: string | null;
  finding_ids: string[];
  finding_types: string[];
  confidence: number | null;
  summary: string | null;
  evidence: {
    action_hint?: string;
    corroboration?: number;
    symptoms?: Array<{ type: string; severity: string; phrase: string }>;
  };
  status: string;
  created_at: string;
}

export interface ActionRow {
  id: string;
  finding_id: string | null;
  action_type: string;
  kind?: 'finding' | 'opportunity' | 'diagnosis';
  subject_type: string;
  label: string | null;
  title: string;
  rationale?: string | null;
  status: string;
  created_at: string;
  // R2 (decisión): metadata determinista de la recomendación.
  confidence?: number | null;
  priority?: number | null;
  expected_impact?: { metric: string; baseline_mean: number; basis: string } | null;
  root_cause?: string | null;
  diagnosis_id?: string | null;
}

export interface TaskRow {
  id: string;
  task_type: 'visit' | 'recover' | 'reprioritize' | 'recapture';
  title: string;
  status: string;
  due_date: string | null;
  assigned_to_user: string | null;
  created_at: string;
}

export interface CoachingNoteRow {
  id: string;
  collaborator_id: string;
  category: string;
  message: string;
  status: string;
  created_at: string;
}

export interface VisionRow {
  id: string;
  capture_id: string;
  foto_url: string | null;
  is_shelf: boolean | null;
  own_brand_visible: boolean | null;
  competitor_visible: boolean | null;
  shelf_quality: number | null;
  out_of_stock: boolean | null;
  photo_quality: string | null;
  mismatch: boolean | null;
  declared_own: boolean | null;
  store_name: string | null;
  captured_by: string | null;
  analyzed_at: string;
}

export interface VisionCoverage {
  photos_total: number;
  analyzed: number;
  is_shelf: number;
  out_of_stock: number;
  mismatch: number;
  unusable: number;
  has_api_key: boolean;
}

export interface SalesExecRow {
  subject_id: string;
  label: string | null;
  exec_score: number | null;
  visits_done?: number;
  revenue_30d?: number;
  units_30d: number;
  competitor_share_pct?: number | null;
  has_sales: boolean;
  quadrant: string | null;
}

export interface SalesExecCoverage {
  window_days: number;
  collaborators_total: number;
  collaborators_with_sales: number;
  stores_total: number;
  stores_with_sales: number;
  sales_data_mature: boolean;
}

export interface SalesExecResponse {
  collaborators: SalesExecRow[];
  stores: SalesExecRow[];
  coverage: SalesExecCoverage | null;
}

export interface RuleStatRow {
  finding_type: string;
  source: string;
  n_total: number;
  n_open: number;
  n_confirmed: number;
  n_dismissed: number;
  n_reviewed: number;
  reviewed_total: number;
  precision: number | null;
  floor_met: boolean;
  auto_suppressed: boolean;
  severity_cap: string | null;
  manual_override: string | null;
  weight: number;
  effective_suppressed: boolean;
}

export interface BaselineRow {
  subject_type: string;
  subject_id: string;
  window_days: number;
  metric: string;
  mean: number | null;
  stddev: number | null;
  n_obs: number;
  min_val: number | null;
  max_val: number | null;
  floor_met: boolean;
}

export interface EffectivenessRow {
  key: string;
  action_type: string;
  measured: number;
  worked: number;
  no_effect: number;
  backfired: number;
  avg_delta: number | null;
  effectiveness: number | null;
}

export interface OutcomeRow {
  id: string;
  action_type: string;
  subject_type: string;
  label: string | null;
  title: string;
  root_cause: string | null;
  outcome_verdict: 'worked' | 'no_effect' | 'backfired' | 'inconclusive';
  outcome_delta: number | null;
  outcome_detail: { metric?: string; before?: number; after?: number; delta?: number; control?: number; net?: number } | null;
  outcome_measured_at: string;
}

export interface ActionExplanation {
  narrative: string;
  source: 'agent' | 'engine';
  reasoning_chain: Array<{ step: string; text: string }>;
  action: { id: string; title: string; action_type: string; confidence: number | null; root_cause: string | null };
}

/** ACT.2/ACT.3 — mapa "rutas reconvertidas". */
export interface RouteOptRow {
  sales_route: string;
  customers: number;
  geolocated: number;
  current_km: number;
  proposed_km: number;
  improvement_pct: number;
  has_action: boolean;
}
export interface RouteOptStop {
  id: string;
  name: string;
  seq: number;
  lat: number | null;
  lng: number | null;
}
export interface RouteOptOpportunity {
  prospect_id: string;
  name: string;
  lat: number;
  lng: number;
  scian_label: string | null;
  whitespace_score: number | null;
  nearest_customer_m: number;
}
export interface RouteOptDetail {
  sales_route: string;
  current: RouteOptStop[];
  proposed: RouteOptStop[];
  opportunities: RouteOptOpportunity[];
  metrics: { current_km: number; proposed_km: number; improvement_pct: number; stops: number } | null;
}

/** ACT.5 — balanceo de carga entre rutas/personas. */
export interface RouteBalanceBin {
  sales_route: string;
  vendor: string | null;
  vendor_user_id: string | null;
  customers: number;
  time_min: number;
}
export interface RouteBalanceMove {
  customer_id: string;
  name: string;
  from_route: string;
  to_route: string;
}
export interface RouteBalanceMetrics {
  routes: number;
  moved: number;
  makespan_before: number;
  makespan_after: number;
  stddev_before: number;
  stddev_after: number;
  improvement_pct: number;
}
export interface RouteBalanceSim {
  day_of_week: number | null;
  before: RouteBalanceBin[];
  after: RouteBalanceBin[];
  moves: RouteBalanceMove[];
  metrics: RouteBalanceMetrics | null;
}

export type ReviewStatus = 'dismissed' | 'confirmed' | 'reviewed';
export type RuleOverride = 'enabled' | 'suppressed' | null;

/** HIQ.0 — "Pregúntale a Horus" (chat tool-use, patrón ADR-026). */
export interface HorusChatTurn {
  role: 'user' | 'assistant';
  content: string;
}
export interface HorusToolTrace {
  name: string;
  input: any;
  result: any;
}
export interface HorusChatResponse {
  answer: string;
  source: 'llm' | 'no_api_key' | 'error';
  tools_used: HorusToolTrace[];
  iterations: number;
  log_id: string | null;
}

@Injectable({ providedIn: 'root' })
export class SupervisorAiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/supervisor-ai`;

  briefing(): Observable<BriefingResponse> {
    return this.http.get<BriefingResponse>(`${this.base}/briefing`);
  }

  /** HIQ.0 — chat stateless: mandamos historial + la pregunta como último turno user. */
  askChat(
    history: HorusChatTurn[],
    question: string,
    opts: { think?: boolean; deepSearch?: boolean } = {},
  ): Observable<HorusChatResponse> {
    return this.http.post<HorusChatResponse>(`${this.base}/chat`, {
      history: [...history, { role: 'user', content: question }],
      think: !!opts.think,
      deep_search: !!opts.deepSearch,
    });
  }

  chatFeedback(logId: string, vote: 1 | -1): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/chat/feedback`, { log_id: logId, vote });
  }

  execution360(
    filters: { subject_type?: string; window_days?: number } = {},
  ): Observable<{ rows: Execution360Row[]; total: number; computed_at: string | null }> {
    let params = new HttpParams();
    if (filters.subject_type) params = params.set('subject_type', filters.subject_type);
    if (filters.window_days) params = params.set('window_days', filters.window_days);
    return this.http.get<{ rows: Execution360Row[]; total: number; computed_at: string | null }>(
      `${this.base}/execution-360`,
      { params },
    );
  }

  findings(
    filters: { status?: string; severity?: string; subject_type?: string } = {},
  ): Observable<{ rows: FindingRow[]; total: number }> {
    let params = new HttpParams();
    if (filters.status) params = params.set('status', filters.status);
    if (filters.severity) params = params.set('severity', filters.severity);
    if (filters.subject_type) params = params.set('subject_type', filters.subject_type);
    return this.http.get<{ rows: FindingRow[]; total: number }>(`${this.base}/findings`, { params });
  }

  review(id: string, status: ReviewStatus): Observable<FindingRow> {
    return this.http.post<FindingRow>(`${this.base}/findings/${id}/review`, { status });
  }

  // R1 (Horus.R): diagnósticos de causa raíz — correlación de ≥2 findings del mismo sujeto.
  diagnoses(status = 'open'): Observable<{ rows: DiagnosisRow[]; total: number }> {
    const params = new HttpParams().set('status', status);
    return this.http.get<{ rows: DiagnosisRow[]; total: number }>(`${this.base}/diagnoses`, { params });
  }

  reviewDiagnosis(id: string, status: ReviewStatus): Observable<{ id: string; status: string }> {
    return this.http.post<{ id: string; status: string }>(`${this.base}/diagnoses/${id}/review`, { status });
  }

  compute(): Observable<{ feature_store: { rows_upserted: number }; findings: { open: number; resolved: number } }> {
    return this.http.post<{ feature_store: { rows_upserted: number }; findings: { open: number; resolved: number } }>(
      `${this.base}/compute`,
      {},
    );
  }

  actions(status = 'pending_approval'): Observable<{ rows: ActionRow[]; total: number }> {
    const params = new HttpParams().set('status', status);
    return this.http.get<{ rows: ActionRow[]; total: number }>(`${this.base}/actions`, { params });
  }

  opportunities(status = 'pending_approval'): Observable<{ rows: ActionRow[]; total: number }> {
    const params = new HttpParams().set('status', status);
    return this.http.get<{ rows: ActionRow[]; total: number }>(`${this.base}/opportunities`, { params });
  }

  tasks(status?: string): Observable<{ rows: TaskRow[]; total: number }> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    return this.http.get<{ rows: TaskRow[]; total: number }>(`${this.base}/tasks`, { params });
  }

  coachingNotes(status?: string): Observable<{ rows: CoachingNoteRow[]; total: number }> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    return this.http.get<{ rows: CoachingNoteRow[]; total: number }>(`${this.base}/coaching-notes`, { params });
  }

  // R3: explica el razonamiento de una acción (cadena determinista + redacción del agente).
  explainAction(id: string): Observable<ActionExplanation> {
    return this.http.get<ActionExplanation>(`${this.base}/actions/${id}/explain`);
  }

  approveAction(id: string): Observable<ActionRow> {
    return this.http.post<ActionRow>(`${this.base}/actions/${id}/approve`, {});
  }

  rejectAction(id: string): Observable<ActionRow> {
    return this.http.post<ActionRow>(`${this.base}/actions/${id}/reject`, {});
  }

  visionScan(max?: number): Observable<{ scan: any; vision_findings: { open: number; resolved: number } }> {
    return this.http.post<{ scan: any; vision_findings: { open: number; resolved: number } }>(
      `${this.base}/vision/scan`,
      max ? { max } : {},
    );
  }

  vision(flagged = false): Observable<{ rows: VisionRow[]; total: number }> {
    let params = new HttpParams();
    if (flagged) params = params.set('flagged', 'true');
    return this.http.get<{ rows: VisionRow[]; total: number }>(`${this.base}/vision`, { params });
  }

  visionCoverage(): Observable<VisionCoverage> {
    return this.http.get<VisionCoverage>(`${this.base}/vision/coverage`);
  }

  salesExecution(): Observable<SalesExecResponse> {
    return this.http.get<SalesExecResponse>(`${this.base}/sales-execution`);
  }

  // Aprendizaje (Horus.L / ADR-021): lo que Horus aprendió sobre sí mismo + lo "normal".
  learningRules(): Observable<{ rows: RuleStatRow[]; total: number; computed_at: string | null }> {
    return this.http.get<{ rows: RuleStatRow[]; total: number; computed_at: string | null }>(
      `${this.base}/learning/rules`,
    );
  }

  learningBaselines(
    filters: { subject_type?: string; metric?: string } = {},
  ): Observable<{ rows: BaselineRow[]; total: number; computed_at: string | null }> {
    let params = new HttpParams();
    if (filters.subject_type) params = params.set('subject_type', filters.subject_type);
    if (filters.metric) params = params.set('metric', filters.metric);
    return this.http.get<{ rows: BaselineRow[]; total: number; computed_at: string | null }>(
      `${this.base}/learning/baselines`,
      { params },
    );
  }

  learningRecompute(): Observable<{ rules: number; suppressed: number }> {
    return this.http.post<{ rules: number; suppressed: number }>(`${this.base}/learning/recompute`, {});
  }

  // R4 (L3): efectividad de las acciones + outcomes medidos (qué funcionó).
  learningEffectiveness(): Observable<{ rows: EffectivenessRow[]; total: number }> {
    return this.http.get<{ rows: EffectivenessRow[]; total: number }>(`${this.base}/learning/effectiveness`);
  }

  outcomes(): Observable<{ rows: OutcomeRow[]; total: number }> {
    return this.http.get<{ rows: OutcomeRow[]; total: number }>(`${this.base}/outcomes`);
  }

  learningOverride(findingType: string, override: RuleOverride, source = 'engine'): Observable<RuleStatRow> {
    return this.http.post<RuleStatRow>(`${this.base}/learning/rules/${findingType}/override`, { override, source });
  }

  // ACT.2/ACT.3 — mapa "rutas reconvertidas".
  routeOptimizations(): Observable<{ routes: RouteOptRow[] }> {
    return this.http.get<{ routes: RouteOptRow[] }>(`${this.base}/route-optimization`);
  }

  routeOptimizationDetail(salesRoute: string): Observable<RouteOptDetail> {
    const params = new HttpParams().set('sales_route', salesRoute);
    return this.http.get<RouteOptDetail>(`${this.base}/route-optimization`, { params });
  }

  // ACT.5 — balanceo de carga.
  routeBalance(dayOfWeek?: number): Observable<RouteBalanceSim> {
    let params = new HttpParams();
    if (dayOfWeek) params = params.set('day_of_week', dayOfWeek);
    return this.http.get<RouteBalanceSim>(`${this.base}/route-balance`, { params });
  }

  applyRouteBalance(dayOfWeek: number): Observable<any> {
    return this.http.post<any>(`${this.base}/route-balance/apply`, { day_of_week: dayOfWeek });
  }

  undoRouteBalance(dayOfWeek: number): Observable<any> {
    return this.http.post<any>(`${this.base}/route-balance/undo`, { day_of_week: dayOfWeek });
  }
}
