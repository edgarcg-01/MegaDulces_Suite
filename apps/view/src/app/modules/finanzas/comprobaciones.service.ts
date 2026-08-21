import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** GX.7 — cliente de solicitudes de reembolso (captura multi-archivo + validación). */

export type ProofStatus = 'recibida' | 'validada' | 'rechazada' | 'revision';

/** Roles de archivo del formulario (Google Form → plataforma). */
export type ProofFileRole = 'comprobante_1' | 'comprobante_2' | 'solicitud_kepler' | 'evidencia_1' | 'evidencia_2' | 'evidencia_3';
export interface ProofFile { role: ProofFileRole | string; url: string; public_id?: string; kind?: string; name?: string; }

export interface Departamento { code: string; nombre: string; sucursal: string; }

/** Último comprobante de una solicitud: qué estado tiene y cuál es, para poder actuar. */
export interface ProofByFolio { id: string; status: ProofStatus | string; }

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
  monto_ocr?: number | null;      // total leído de la foto (Claude Vision)
  monto_match?: boolean | null;   // cuadró vs el importe de la solicitud
  revision_nota?: string | null;  // por qué quedó en revisión
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ExpenseProofsReport {
  kpis: { total: number; recibidas: number; validadas: number; rechazadas: number; en_revision?: number };
  rows: ExpenseProof[];
}

/** Resultado del preview de validación por vision del comprobante. */
export interface ProofPhotoOcr {
  ocr_status: 'ok' | 'ilegible' | 'sin_key';
  importe_esperado: number;
  monto_ocr: number | null;
  monto_match: boolean;
  diff: number | null;
  total: number | null;
  subtotal: number | null;
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
  monto_ocr?: number | null;
  subtotal_ocr?: number | null;
  receipt_legible?: boolean;
}

/** Detalle + señal de si el bucket está configurado (para no confundir "sin adjunto" con "no lo puedo servir"). */
export interface ExpenseProofDetail extends ExpenseProof { storage_ok?: boolean; }

@Injectable({ providedIn: 'root' })
export class ComprobacionesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/expenses/proofs`;

  list(q: { status?: string; folio_solicitud?: string; search?: string; from?: string; to?: string } = {}): Observable<ExpenseProofsReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<ExpenseProofsReport>(this.base, { params });
  }
  /** Sube UN archivo (base64 data URI) y devuelve su referencia (bucket privado). */
  uploadFile(file_base64: string, role: ProofFileRole): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/upload`, { file_base64, role });
  }
  /** Preview: valida la foto del comprobante con Claude Vision contra el importe de la solicitud. */
  validatePhoto(file_base64: string, importe: number): Observable<ProofPhotoOcr> {
    return this.http.post<ProofPhotoOcr>(`${this.base}/validate-photo`, { file_base64, importe });
  }
  create(body: CreateExpenseProof): Observable<{ id: string; folio_solicitud: string; status: string }> {
    return this.http.post<{ id: string; folio_solicitud: string; status: string }>(this.base, body);
  }
  /**
   * Detalle con los adjuntos RE-FIRMADOS. La lista los firma con TTL de 10 min; quien
   * revisa abre la fila mucho después y la URL ya venció (se veía como archivo perdido).
   */
  detail(id: string): Observable<ExpenseProofDetail> {
    return this.http.get<ExpenseProofDetail>(`${this.base}/${id}`);
  }
  validate(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
  departamentos(): Observable<Departamento[]> { return this.http.get<Departamento[]>(`${this.base}/departamentos`); }
  /** (C) folio_solicitud → estado, para el indicador en Solicitudes. */
  /** Estado + ID del último comprobante por folio de solicitud. El ID permite validar o
   *  rechazar desde donde se esté viendo, sin saltar a otra pantalla a buscarlo. */
  statusByFolio(): Observable<Record<string, ProofByFolio>> { return this.http.get<Record<string, ProofByFolio>>(`${this.base}/status-by-folio`); }
}
