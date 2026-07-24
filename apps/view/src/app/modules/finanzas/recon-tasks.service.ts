import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * MA — cliente de las tareas de conciliación (Maat). Los movimientos sin conciliar
 * en Kepler, agrupados por proveedor y repartidos a Finanzas para capturarlos allá.
 */

export type ReconTaskStatus = 'pendiente' | 'en_proceso' | 'resuelto' | 'no_aplica';

export interface ReconTask {
  id: string;
  rule_key: string;
  periodo: string;
  group_key: string;
  proveedor_label: string;
  finding_ids: string[];
  n_movimientos: number;
  importe_total: number;
  assigned_to: string | null;
  assigned_to_username: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  status: ReconTaskStatus;
  due_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resolution_source: 'verificado' | 'manual' | null;
  kepler_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReconTaskStats {
  pendientes: number;
  en_proceso: number;
  resueltas: number;
  pool: number;
  monto_abierto: number;
  por_usuario: { user_id: string; username: string | null; n: number; monto: number }[];
}

export interface FinanceUser { id: string; username: string; full_name: string | null; }

export type ReconMsgRole = 'user' | 'maat';
export type ReconMsgKind = 'comment' | 'report' | 'verify' | 'assignment';
export interface ReconTaskMessage {
  id: string; role: ReconMsgRole; kind: ReconMsgKind; username: string | null;
  body: string; meta: Record<string, any> | null; created_at: string;
}
export interface ReportResult {
  verified: boolean; matched: number; pending: number;
  next: { id: string; proveedor_label: string; importe_total: number; n_movimientos: number } | null;
}

export type ReconCausa = 'pago_en_102' | 'factura_sin_pago' | 'revisar_cadena' | 'capturar_desde_cero' | 'sin_diagnostico';
export interface ReconMovementDetail {
  finding_id: string; bank_movement_id: string; fecha: string; monto: number;
  banco: string; cuenta: string; concepto: string; categoria: string | null; recon_status: string;
  causa: ReconCausa; causa_label: string; folio_102: string | null; factura_folio: string | null; instruccion: string;
}
export interface ReconTaskDetail {
  task: { id: string; proveedor_label: string; periodo: string; n_movimientos: number; importe_total: number; status: ReconTaskStatus; assigned_to_username: string | null };
  movimientos: ReconMovementDetail[];
  resumen: Record<string, number>;
}

export interface RunResult {
  periodo: string; grupos: number; upserted: number; skipped_small: number;
  min_importe: number; assigned: number; users: number; cerradas_verificadas: number;
}

@Injectable({ providedIn: 'root' })
export class ReconTasksService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/maat/recon-tasks`;

  list(q?: { scope?: 'me' | 'all' | 'pool'; status?: string; periodo?: string; limit?: number }): Observable<ReconTask[]> {
    const p = new URLSearchParams();
    if (q?.scope) p.set('scope', q.scope);
    if (q?.status) p.set('status', q.status);
    if (q?.periodo) p.set('periodo', q.periodo);
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<ReconTask[]>(`${this.base}${qs ? '?' + qs : ''}`);
  }

  stats(periodo?: string): Observable<ReconTaskStats> {
    return this.http.get<ReconTaskStats>(`${this.base}/stats${periodo ? '?periodo=' + periodo : ''}`);
  }

  financeUsers(): Observable<FinanceUser[]> { return this.http.get<FinanceUser[]>(`${this.base}/finance-users`); }

  run(periodo: string, min_importe?: number): Observable<RunResult> {
    return this.http.post<RunResult>(`${this.base}/run`, { periodo, min_importe });
  }
  assignPending(periodo?: string): Observable<{ assigned: number; users: number }> {
    return this.http.post<{ assigned: number; users: number }>(`${this.base}/assign-pending`, { periodo });
  }
  verifyClosure(periodo?: string): Observable<{ closed: number }> {
    return this.http.post<{ closed: number }>(`${this.base}/verify-closure`, { periodo });
  }
  setStatus(id: string, status: ReconTaskStatus, note?: string, kepler_ref?: string): Observable<any> {
    return this.http.patch(`${this.base}/${id}/status`, { status, note, kepler_ref });
  }
  assignManual(id: string, user_id: string | null): Observable<any> {
    return this.http.post(`${this.base}/${id}/assign`, { user_id });
  }

  detail(id: string): Observable<ReconTaskDetail> { return this.http.get<ReconTaskDetail>(`${this.base}/${id}/detail`); }

  // ── Chat por tarea (MA.8) ──
  messages(id: string): Observable<ReconTaskMessage[]> { return this.http.get<ReconTaskMessage[]>(`${this.base}/${id}/messages`); }
  postMessage(id: string, body: string): Observable<ReconTaskMessage> { return this.http.post<ReconTaskMessage>(`${this.base}/${id}/messages`, { body }); }
  reportDone(id: string, body?: string): Observable<ReportResult> { return this.http.post<ReportResult>(`${this.base}/${id}/report`, { body }); }
}
