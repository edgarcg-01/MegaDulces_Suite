import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** GX.7 — cliente de solicitudes de reembolso (captura multi-archivo + validación). */

export type ProofStatus = 'recibida' | 'validada' | 'rechazada';

/** Roles de archivo del formulario (Google Form → plataforma). */
export type ProofFileRole = 'comprobante_1' | 'comprobante_2' | 'solicitud_kepler' | 'evidencia_1' | 'evidencia_2' | 'evidencia_3';
export interface ProofFile { role: ProofFileRole | string; url: string; public_id?: string; kind?: string; name?: string; }

export interface Departamento { code: string; nombre: string; sucursal: string; }

export interface ExpenseProof {
  id: string;
  solicitante: string;
  departamento: string;
  departamento_code: string | null;
  sucursal: string | null;
  fecha_gasto: string | null;
  folio_solicitud: string;
  proveedor: string;
  importe: number;
  files: ProofFile[];
  comentarios: string | null;
  status: ProofStatus;
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ExpenseProofsReport {
  kpis: { total: number; recibidas: number; validadas: number; rechazadas: number };
  rows: ExpenseProof[];
}

export interface CreateExpenseProof {
  solicitante?: string;
  departamento?: string;
  departamento_code?: string;
  sucursal?: string;
  fecha_gasto?: string;
  folio_solicitud?: string;
  proveedor?: string;
  importe?: number;
  comentarios?: string;
  files?: ProofFile[];
}

@Injectable({ providedIn: 'root' })
export class ComprobacionesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/expenses/proofs`;

  list(q: { status?: string; folio_solicitud?: string; search?: string; from?: string; to?: string } = {}): Observable<ExpenseProofsReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<ExpenseProofsReport>(this.base, { params });
  }
  /** Sube UN archivo (base64 data URI) y devuelve su referencia Cloudinary. */
  uploadFile(file_base64: string, role: ProofFileRole): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/upload`, { file_base64, role });
  }
  create(body: CreateExpenseProof): Observable<{ id: string; folio_solicitud: string; status: string }> {
    return this.http.post<{ id: string; folio_solicitud: string; status: string }>(this.base, body);
  }
  validate(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
  departamentos(): Observable<Departamento[]> { return this.http.get<Departamento[]>(`${this.base}/departamentos`); }
  /** (C) folio_solicitud → estado, para el indicador en Solicitudes. */
  statusByFolio(): Observable<Record<string, string>> { return this.http.get<Record<string, string>>(`${this.base}/status-by-folio`); }
}
