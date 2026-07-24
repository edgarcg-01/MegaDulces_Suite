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
}
