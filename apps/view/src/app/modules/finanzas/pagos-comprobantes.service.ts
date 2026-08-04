import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * CC (extensión) — cliente de Comprobantes de Pago a Proveedor. Lista los pagos de
 * Kepler (transferencia XD2601 + cheque XD2501) y les adjunta el comprobante
 * (imagen/PDF) con OCR. No escribe a Kepler.
 */

export type ProofStatus = 'recibido' | 'validado' | 'rechazado';

export interface PagoRow {
  sucursal: string;
  folio: string;
  doc_prefix: string;            // XD2601 (transferencia) | XD2501 (cheque)
  metodo_pago: string | null;    // 'transferencia' | 'cheque'
  pago_date: string | null;
  proveedor_code: string | null;
  proveedor_nombre: string | null;
  proveedor_rfc: string | null;
  concepto: string | null;
  monto: number;
  deposits: number;
  deposit_id: string | null;
  deposit_status: ProofStatus | null;
  monto_match: boolean;
}

export interface PagosReport {
  kpis: { pagos: number; con_comprobante: number; validados: number; monto_pendiente: number };
  rows: PagoRow[];
}

/** Campos que devuelve el OCR del comprobante (mismo shape que la ficha de depósito). */
export interface DepositOcr {
  monto: number | null;
  fecha: string | null;
  banco: string | null;
  cuenta_dest: string | null;
  referencia: string | null;
  ordenante: string | null;
  metodo: string | null;
  ocr_status: string;
}

export interface ProofFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

/** Una evidencia adjunta (con sus archivos + OCR + estado) — devuelta por detail(). */
export interface ProofDeposit {
  id: string;
  files: ProofFile[];
  ocr_monto: number | null;
  ocr_fecha: string | null;
  ocr_banco: string | null;
  ocr_cuenta_dest: string | null;
  ocr_referencia: string | null;
  ocr_ordenante: string | null;
  ocr_metodo: string | null;
  ocr_status: string;
  monto_match: boolean | null;
  status: ProofStatus;
  comentarios: string | null;
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

export interface PagoDetail {
  pago: {
    sucursal: string; folio: string; doc_prefix?: string; metodo_pago?: string | null;
    pago_date: string | null; proveedor_code: string | null; proveedor_nombre: string | null;
    proveedor_rfc: string | null; concepto: string | null; monto: number;
  };
  deposits: ProofDeposit[];
}

export interface AttachPayment {
  sucursal: string;
  folio: string;
  doc_prefix?: string;
  files: ProofFile[];
  ocr?: Partial<DepositOcr>;
  comentarios?: string;
}

@Injectable({ providedIn: 'root' })
export class PagosComprobantesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/supplier-payments`;

  list(q: { estado?: string; from?: string; to?: string; search?: string } = {}): Observable<PagosReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<PagosReport>(this.base, { params });
  }
  /** Detalle del pago + sus comprobantes adjuntos (archivos + OCR + estado). */
  detail(sucursal: string, folio: string, doc_prefix?: string): Observable<PagoDetail> {
    let params = new HttpParams();
    if (doc_prefix) params = params.set('doc_prefix', doc_prefix);
    return this.http.get<PagoDetail>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(folio)}`, { params });
  }
  /** Corre OCR sobre el comprobante (data URI, imagen/PDF) — preview, no guarda. */
  ocr(file_base64: string): Observable<DepositOcr> {
    return this.http.post<DepositOcr>(`${this.base}/ocr`, { file_base64 });
  }
  /** Sube el comprobante a Cloudinary y devuelve su referencia. */
  uploadFile(file_base64: string, role = 'comprobante'): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/upload`, { file_base64, role });
  }
  /** Adjunta la evidencia al pago (archivos ya subidos + OCR). */
  attach(body: AttachPayment): Observable<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean }> {
    return this.http.post<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean }>(`${this.base}/attach`, body);
  }
  validate(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
}
