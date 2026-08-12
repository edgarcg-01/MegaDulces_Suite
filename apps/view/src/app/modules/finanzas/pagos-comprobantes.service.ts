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
  cuenta_ajena?: boolean; // el pago salió de una cuenta NO propia
  ref_dup?: boolean;      // la clave de rastreo aparece en otro pago
  alerta?: boolean;
}

export interface PagosReport {
  kpis: { pagos: number; con_comprobante: number; validados: number; monto_pendiente: number; cuentas_ajenas?: number; refs_duplicadas?: number };
  rows: PagoRow[];
}

/** Campos del OCR de un comprobante de PAGO A PROVEEDOR (transferencia saliente). */
export interface DepositOcr {
  monto: number | null;
  fecha: string | null;
  concepto: string | null;       // "Concepto de pago" = folio(s) de factura (F 451)
  cuenta_origen: string | null;  // cuenta de retiro (nuestra)
  cuenta_destino: string | null; // cuenta del proveedor
  beneficiario: string | null;   // proveedor que recibe
  clave_rastreo: string | null;
  banco_destino: string | null;
  metodo: string | null;
  ocr_status: string;
}

export interface ProofFile { role: string; url: string; public_id?: string; kind?: string; name?: string; ocr_monto?: number | null; }

/** Un cargo del estado de cuenta (finance.bank_movements, amount_out). */
export interface BankMovementMatch {
  id: string; movement_date: string; amount_out: number; concept: string | null;
  bank: string; account_label: string;
  match_type?: string; matched_by?: string | null; matched_at?: string; kepler_amount?: number | null;
}
export interface BankMatch {
  conciliado: boolean;
  estado: 'confirmado' | 'multiple' | 'sin_match' | 'sin_dato';
  matched: BankMovementMatch[];
  candidatos: BankMovementMatch[];
}

/** Una evidencia adjunta (con sus archivos + OCR + estado) — devuelta por detail(). */
export interface ProofDeposit {
  id: string;
  files: ProofFile[];
  ocr_monto: number | null;
  ocr_fecha: string | null;
  ocr_banco: string | null;
  ocr_cuenta_dest: string | null;
  ocr_cuenta_origen: string | null;
  ocr_concepto: string | null;
  ocr_referencia: string | null;
  ocr_ordenante: string | null;
  ocr_metodo: string | null;
  ocr_status: string;
  monto_match: boolean | null;
  cuenta_propia?: boolean | null;
  ref_duplicada?: boolean;
  ref_otros?: string[];
  banco?: BankMatch;
  status: ProofStatus;
  comentarios: string | null;
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

/** Un pago candidato para ligar (ficha-first). */
export interface PagoCandidate {
  sucursal: string; folio: string; doc_prefix: string; metodo_pago: string | null;
  pago_date: string | null; proveedor_code: string | null; proveedor_nombre: string | null;
  proveedor_rfc: string | null; concepto: string | null; monto: number;
  deposits: number; concepto_match?: boolean;
}

/** Nota de crédito / devolución de compra (X-D-55/X-D-40) que explica el delta factura vs pago. */
export interface RelatedAdjustment {
  doctype: string;              // XD55 (nota crédito) | XD40 (devolución)
  adjustment_date: string | null;
  factura_ref: string | null;
  motivo: string | null;
  categoria: string | null;
  monto: number;
  factura_match: boolean;       // la factura de la nota coincide con el concepto del pago
}
export interface RelatedAdjustments {
  rows: RelatedAdjustment[];
  total_monto: number;
  total_factura: number;        // suma de las notas que ligan a la(s) factura(s) del pago
  deep_link_q: string | null;   // término para /compras/descuentos?q=
}

export interface PagoDetail {
  pago: {
    sucursal: string; folio: string; doc_prefix?: string; metodo_pago?: string | null;
    pago_date: string | null; proveedor_code: string | null; proveedor_nombre: string | null;
    proveedor_rfc: string | null; concepto: string | null; monto: number;
  };
  deposits: ProofDeposit[];
  adjustments?: RelatedAdjustments;
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

  list(q: { estado?: string; from?: string; to?: string; search?: string; metodo?: string; alertas?: string } = {}): Observable<PagosReport> {
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
  /** Corre OCR — `comprobante` (PDF pago) o `gasto` (foto factura → total). Preview. */
  ocr(file_base64: string, role?: string): Observable<DepositOcr> {
    return this.http.post<DepositOcr>(`${this.base}/ocr`, { file_base64, role });
  }
  /** Ficha-first: busca el pago por monto + fecha + concepto (folio de factura). */
  matchPago(monto: number | null | undefined, fecha: string | null | undefined, concepto: string | null | undefined): Observable<{ pagos: PagoCandidate[] }> {
    return this.http.post<{ pagos: PagoCandidate[] }>(`${this.base}/match-pago`, { monto, fecha, concepto });
  }
  /** Sube el comprobante a Cloudinary y devuelve su referencia. */
  uploadFile(file_base64: string, role = 'comprobante'): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/upload`, { file_base64, role });
  }
  /** Adjunta la evidencia al pago (archivos ya subidos + OCR). */
  attach(body: AttachPayment): Observable<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean; cuenta_propia?: boolean | null; ref_duplicada?: boolean; ref_otros?: string[] }> {
    return this.http.post<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean; cuenta_propia?: boolean | null; ref_duplicada?: boolean; ref_otros?: string[] }>(`${this.base}/attach`, body);
  }
  validate(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
  confirmBank(id: string, bank_movement_id: string): Observable<any> { return this.http.post(`${this.base}/${id}/bank-match`, { bank_movement_id }); }
  unlinkBank(id: string, bank_movement_id: string): Observable<any> { return this.http.post(`${this.base}/${id}/bank-unmatch`, { bank_movement_id }); }
}
