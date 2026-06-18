import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

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
  by_concept?: Record<string, { label: string | null; n: number; level_avg: number | null; own_share_pct: number | null; photo_pct: number | null }> | null;
  by_location?: Record<string, { label: string | null; n: number; level_avg: number | null }> | null;
  planogram_present?: number | null;
  planogram_total?: number | null;
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

export interface ActionRow {
  id: string;
  finding_id: string | null;
  action_type: string;
  kind?: 'finding' | 'opportunity';
  subject_type: string;
  label: string | null;
  title: string;
  rationale?: string | null;
  status: string;
  created_at: string;
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

export type ReviewStatus = 'dismissed' | 'confirmed' | 'reviewed';
export type RuleOverride = 'enabled' | 'suppressed' | null;

@Injectable({ providedIn: 'root' })
export class SupervisorAiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/supervisor-ai`;

  briefing(): Observable<BriefingResponse> {
    return this.http.get<BriefingResponse>(`${this.base}/briefing`);
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

  learningOverride(findingType: string, override: RuleOverride, source = 'engine'): Observable<RuleStatRow> {
    return this.http.post<RuleStatRow>(`${this.base}/learning/rules/${findingType}/override`, { override, source });
  }
}
