import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * FISCAL.0/1 — cliente del motor de listas SAT (EFOS 69-B, Art. 69) + validación
 * de RFC. Consume /fiscal/listas/*. Superficie Operations (proyecto Finanzas).
 */

export type FiscalEstado = 'nuevo' | 'en_revision' | 'confirmado' | 'descartado';

export interface SatListMatch {
  id: string;
  lista: string;
  rfc: string;
  nombre: string | null;
  situacion: string;
  doc_count: number;
  importe_total: number;
  iva_total: number;
  primera_fecha: string | null;
  ultima_fecha: string | null;
  estado: FiscalEstado;
  nota: string | null;
  list_hash: string | null;
  severidad: number;
}

export interface RfcIssue {
  id: string;
  rfc: string;
  issue_type: string;
  doc_count: number;
  importe_total: number;
  primera_fecha: string | null;
  ultima_fecha: string | null;
  estado: FiscalEstado;
  nota: string | null;
}

export interface ListasStats {
  exposicion_riesgo_mxn: number;
  pendientes_riesgo: number;
  por_lista: { lista: string; situacion: string; count: number; importe: number }[];
  rfc_issues: { issue_type: string; count: number }[];
}

export interface ListStatus {
  lista: string;
  label: string;
  cargada: boolean;
  list_hash: string | null;
  procesada_en: string | null;
  total_rfcs: number;
  edad_horas: number | null;
}

export interface ExpenseDoc {
  sucursal: string;
  doc_tipo: string;
  doc_folio: string;
  fecha: string | null;
  beneficiario: string | null;
  concepto: string | null;
  importe: number;
  iva: number;
  area: string | null;
}

@Injectable({ providedIn: 'root' })
export class ListasSatService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/listas`;

  matches(q?: { lista?: string; situacion?: string; estado?: string; limit?: number }): Observable<SatListMatch[]> {
    const p = new URLSearchParams();
    if (q?.lista) p.set('lista', q.lista);
    if (q?.situacion) p.set('situacion', q.situacion);
    if (q?.estado) p.set('estado', q.estado);
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<SatListMatch[]>(`${this.base}/matches${qs ? '?' + qs : ''}`);
  }

  stats(): Observable<ListasStats> { return this.http.get<ListasStats>(`${this.base}/stats`); }
  status(): Observable<ListStatus[]> { return this.http.get<ListStatus[]>(`${this.base}/status`); }
  documents(rfc: string): Observable<ExpenseDoc[]> { return this.http.get<ExpenseDoc[]>(`${this.base}/matches/${encodeURIComponent(rfc)}/documents`); }
  rfcIssues(q?: { issue_type?: string; estado?: string; limit?: number }): Observable<RfcIssue[]> {
    const p = new URLSearchParams();
    if (q?.issue_type) p.set('issue_type', q.issue_type);
    if (q?.estado) p.set('estado', q.estado);
    if (q?.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return this.http.get<RfcIssue[]>(`${this.base}/rfc-issues${qs ? '?' + qs : ''}`);
  }

  setMatchEstado(id: string, estado: FiscalEstado, nota?: string): Observable<any> {
    return this.http.patch(`${this.base}/matches/${id}/estado`, { estado, nota });
  }
  setIssueEstado(id: string, estado: FiscalEstado, nota?: string): Observable<any> {
    return this.http.patch(`${this.base}/rfc-issues/${id}/estado`, { estado, nota });
  }
  scan(): Observable<{ listas: any[]; rfc: any; maat: any }> { return this.http.post<{ listas: any[]; rfc: any; maat: any }>(`${this.base}/scan`, {}); }
  refresh(): Observable<{ tenants: number; matched: number; issues: number }> { return this.http.post<{ tenants: number; matched: number; issues: number }>(`${this.base}/refresh`, {}); }
}
