import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** GX.7 — cliente de solicitudes de reembolso (captura multi-archivo + validación). */

export type ProofStatus = 'recibida' | 'aprobada' | 'validada' | 'rechazada' | 'revision';

/** Roles de archivo del formulario (Google Form → plataforma). */
export type ProofFileRole = 'comprobante_1' | 'comprobante_2' | 'solicitud_kepler' | 'evidencia_1' | 'evidencia_2' | 'evidencia_3';
export interface ProofFile { role: ProofFileRole | string; url: string; public_id?: string; kind?: string; name?: string; }

/** Naturaleza del gasto — decide si la evidencia (factura/ticket) es obligatoria. */
export type ExpenseClasificacion = 'fiscal' | 'no_fiscal_comprobable' | 'no_comprobable';
/** ¿Este gasto debe llevar evidencia adjunta? Todo salvo lo declarado no_comprobable. */
export function requiereEvidencia(c?: string | null): boolean {
  return c === 'fiscal' || c === 'no_fiscal_comprobable';
}
/** Etiquetas de la clasificación para la UI. */
export const CLASIFICACION_LABEL: Record<ExpenseClasificacion, string> = {
  fiscal: 'Fiscal (con factura)',
  no_fiscal_comprobable: 'No fiscal, con recibo',
  no_comprobable: 'No comprobable',
};

export interface Departamento { code: string; nombre: string; sucursal: string; }

/**
 * El expediente de una solicitud, resumido para el tablero: qué estado tiene, cuál es
 * (para poder actuar) y QUÉ DOCUMENTOS hay. Los tres faltantes posibles —comprobante,
 * solicitud firmada, comprobación— son tres pendientes distintos para quien aprueba.
 */
export interface ProofByFolio {
  id: string;
  status: ProofStatus | string;
  comprobante?: boolean;
  solicitud?: boolean;
  clasificacion?: ExpenseClasificacion | string | null;
  requiere_evidencia?: boolean;
  tiene_comprobacion?: boolean | null;
  comprobacion_nota?: string | null;
}

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
  clasificacion?: ExpenseClasificacion | string | null; // naturaleza del gasto (decide la evidencia)
  monto_ocr?: number | null;      // total leído de la foto (Claude Vision)
  monto_match?: boolean | null;   // cuadró vs el importe de la solicitud
  tiene_comprobacion?: boolean | null; // (XA1001, dormante) lo declaraba quien valida
  comprobacion_nota?: string | null;
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
  /** Naturaleza del gasto — obligatoria: decide si la evidencia es obligatoria. */
  clasificacion?: ExpenseClasificacion;
  files?: ProofFile[];
  monto_ocr?: number | null;
  subtotal_ocr?: number | null;
  receipt_legible?: boolean;
}

/** Una solicitud de Kepler como candidata para adjuntarle el comprobante. */
export interface SolicitudSug {
  folio: string; sucursal: string | null; fecha: string | null; solicitante: string | null;
  beneficiario: string | null; concepto: string | null; estado: string | null; aplicada: boolean; importe: number;
}

/** Detalle + señal de si el bucket está configurado (para no confundir "sin adjunto" con "no lo puedo servir"). */
export interface ExpenseProofDetail extends ExpenseProof { storage_ok?: boolean; requiere_evidencia?: boolean; }

@Injectable({ providedIn: 'root' })
export class ComprobacionesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/expenses/proofs`;

  list(q: { status?: string; folio_solicitud?: string; search?: string; from?: string; to?: string } = {}): Observable<ExpenseProofsReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<ExpenseProofsReport>(this.base, { params });
  }
  /**
   * Busca la SOLICITUD contra la que se sube el comprobante. El folio se resuelve por
   * valor numérico: teclear los últimos dígitos alcanza («23» → `0000023`).
   */
  searchSolicitudes(q: string, limit = 20): Observable<SolicitudSug[]> {
    return this.http.get<SolicitudSug[]>(`${this.base}/search-solicitudes`,
      { params: new HttpParams().set('q', q).set('limit', String(limit)) });
  }
  /** Lo que capturó este usuario (ruta propia, acotada por el token). */
  mine(limit = 50): Observable<ExpenseProofsReport> {
    return this.http.get<ExpenseProofsReport>(`${this.base}/mine`, { params: new HttpParams().set('limit', String(limit)) });
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
  /** Valida el expediente. Puede reclasificar el gasto (si el capturista se equivocó). */
  validate(id: string, body?: { clasificacion?: string; comprobacion_nota?: string }): Observable<any> {
    return this.http.post(`${this.base}/${id}/validate`, body || {});
  }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
  /** MOMENTO 2 — aprueba la solicitud capturada. Comprobable → aprobada; no comprobable → validada. */
  approve(id: string, body?: { clasificacion?: string; comprobacion_nota?: string }): Observable<any> {
    return this.http.post(`${this.base}/${id}/approve`, body || {});
  }
  /** MOMENTO 3 — sube la evidencia de un gasto ya aprobado y comprobable (cuadre por visión → validada/revision). */
  addEvidence(id: string, body: CreateExpenseProof): Observable<{ id: string; folio_solicitud: string; status: string }> {
    return this.http.post<{ id: string; folio_solicitud: string; status: string }>(`${this.base}/${id}/evidence`, body);
  }
  /** Estado del expediente de un folio (para saber en qué momento está la captura). Accesible al capturista. */
  proofByFolio(folio: string): Observable<ProofByFolio | null> {
    return this.http.get<ProofByFolio | null>(`${this.base}/proof-by-folio`, { params: new HttpParams().set('folio', folio) });
  }
  departamentos(): Observable<Departamento[]> { return this.http.get<Departamento[]>(`${this.base}/departamentos`); }
  /** (C) folio_solicitud → estado, para el indicador en Solicitudes. */
  /** Estado + ID del último comprobante por folio de solicitud. El ID permite validar o
   *  rechazar desde donde se esté viendo, sin saltar a otra pantalla a buscarlo. */
  statusByFolio(): Observable<Record<string, ProofByFolio>> { return this.http.get<Record<string, ProofByFolio>>(`${this.base}/status-by-folio`); }
}
