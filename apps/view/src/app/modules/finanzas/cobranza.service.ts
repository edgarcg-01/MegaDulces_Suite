import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * CC — cliente de Comprobantes de Cobranza. Lista los cobros de Kepler (UA0501) y
 * les adjunta la ficha de depósito (imagen/PDF) con OCR. No escribe a Kepler.
 */

export type DepositStatus = 'recibido' | 'validado' | 'rechazado';

export interface CobroRow {
  sucursal: string;
  folio: string;
  cobro_date: string | null;
  cliente_code: string | null;
  cliente_nombre: string | null;
  concepto: string | null;
  forma_pago: string | null;
  monto: number;
  tipo_cuenta: string | null;
  deposits: number;
  deposit_id: string | null;
  deposit_status: DepositStatus | null;
  monto_match: boolean;
  cuenta_ajena?: boolean; // la ficha depositó a una cuenta NO propia
  ref_dup?: boolean;      // el folio electrónico aparece en otro cobro
  alerta?: boolean;       // cuenta_ajena || ref_dup
}

export interface CobrosReport {
  kpis: { cobros: number; con_comprobante: number; validados: number; monto_pendiente: number; cuentas_ajenas?: number; refs_duplicadas?: number };
  rows: CobroRow[];
}

/** Campos que devuelve el OCR de la ficha (preview antes de guardar). */
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

export interface DepositFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

/** Un abono del estado de cuenta (finance.bank_movements, fase CB). */
export interface BankMovementMatch {
  id: string; movement_date: string; amount_in: number; concept: string | null;
  bank: string; account_label: string; categoria: string | null;
  match_type?: string; matched_by?: string | null; matched_at?: string; kepler_amount?: number | null;
}

/** Resultado del three-way match del depósito contra el banco. */
export interface BankMatch {
  conciliado: boolean;                  // ya hay un cruce persistido en bank_recon_matches
  estado: 'confirmado' | 'multiple' | 'sin_match' | 'sin_dato';
  matched: BankMovementMatch[];         // abonos ya ligados a este cobro
  candidatos: BankMovementMatch[];      // sugerencias (cuando aún no está conciliado)
}

/** Una evidencia adjunta (archivos + OCR + estado) — devuelta por detail(). */
export interface ProofDeposit {
  id: string;
  files: DepositFile[];
  ocr_monto: number | null;
  ocr_fecha: string | null;
  ocr_banco: string | null;
  ocr_cuenta_dest: string | null;
  ocr_referencia: string | null;
  ocr_ordenante: string | null;
  ocr_metodo: string | null;
  ocr_status: string;
  monto_match: boolean | null;
  cuenta_propia?: boolean | null; // cuenta destino ∈ cuentas propias
  ref_duplicada?: boolean;        // folio electrónico usado en otro cobro
  ref_otros?: string[];           // otros cobros (suc/folio) con la misma referencia
  banco?: BankMatch;              // three-way match: abono real en el estado de cuenta (CB)
  status: DepositStatus;
  comentarios: string | null;
  validated_by: string | null;
  validated_at: string | null;
  motivo_rechazo: string | null;
  created_by: string | null;
  created_at: string;
}

export interface CobroDetail {
  cobro: {
    sucursal: string; folio: string; cobro_date: string | null; cliente_code: string | null;
    cliente_nombre: string | null; concepto: string | null; forma_pago: string | null;
    monto: number; tipo_cuenta: string | null;
  };
  deposits: ProofDeposit[];
}

export interface AttachDeposit {
  sucursal: string;
  folio: string;
  files: DepositFile[];
  ocr?: Partial<DepositOcr>;
  comentarios?: string;
}

/** Caso B — un abono en banco (cobranza) que no está ligado a ningún cobro. */
export interface UnmatchedBankRow {
  id: string; movement_date: string; amount_in: number; concept: string | null;
  bank: string; account_label: string; tiene_candidato: boolean;
}
export interface UnmatchedBankReport {
  kpis: { abonos: number; monto: number; huerfanos: number };
  rows: UnmatchedBankRow[];
}
/** Un cobro candidato para ligar a un abono huérfano. */
export interface CobroCandidate {
  sucursal: string; folio: string; cobro_date: string | null; cliente_code: string | null;
  cliente_nombre: string | null; forma_pago: string | null; monto: number;
}
export interface BankCandidates {
  movimiento: { id: string; amount_in: number; movement_date: string };
  cobros: CobroCandidate[];
}

@Injectable({ providedIn: 'root' })
export class CobranzaService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/collections`;

  list(q: { estado?: string; forma_pago?: string; tipo_cuenta?: string; incluir_todas?: string; from?: string; to?: string; search?: string } = {}): Observable<CobrosReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<CobrosReport>(this.base, { params });
  }
  /** Detalle del cobro + sus fichas adjuntas (archivos + OCR + estado). */
  detail(sucursal: string, folio: string): Observable<CobroDetail> {
    return this.http.get<CobroDetail>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(folio)}`);
  }
  /** Corre OCR sobre la ficha (data URI, imagen/PDF) — preview, no guarda. */
  ocr(file_base64: string): Observable<DepositOcr> {
    return this.http.post<DepositOcr>(`${this.base}/ocr`, { file_base64 });
  }
  /** Sube la ficha a Cloudinary y devuelve su referencia. */
  uploadFile(file_base64: string, role = 'deposito'): Observable<DepositFile> {
    return this.http.post<DepositFile>(`${this.base}/upload`, { file_base64, role });
  }
  /** Adjunta la evidencia al cobro (archivos ya subidos + OCR). */
  attach(body: AttachDeposit): Observable<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean; cuenta_propia?: boolean | null; ref_duplicada?: boolean; ref_otros?: string[] }> {
    return this.http.post<{ id: string; sucursal: string; folio: string; status: string; monto_match: boolean; cuenta_propia?: boolean | null; ref_duplicada?: boolean; ref_otros?: string[] }>(`${this.base}/attach`, body);
  }
  validate(id: string): Observable<any> { return this.http.post(`${this.base}/${id}/validate`, {}); }
  reject(id: string, motivo?: string): Observable<any> { return this.http.post(`${this.base}/${id}/reject`, { motivo }); }
  /** Confirma que un abono del banco corresponde al cobro (persiste la conciliación). */
  confirmBank(id: string, bank_movement_id: string): Observable<any> { return this.http.post(`${this.base}/${id}/bank-match`, { bank_movement_id }); }
  /** Deshace la conciliación cobro↔abono. */
  unlinkBank(id: string, bank_movement_id: string): Observable<any> { return this.http.post(`${this.base}/${id}/bank-unmatch`, { bank_movement_id }); }

  // ── Caso B: abonos en banco sin cobro ──
  /** Abonos de cobranza no ligados a ningún cobro. */
  unmatchedBank(q: { from?: string; to?: string; search?: string; solo_huerfanos?: string } = {}): Observable<UnmatchedBankReport> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v) params = params.set(k, String(v));
    return this.http.get<UnmatchedBankReport>(`${this.base}/bank/unmatched`, { params });
  }
  /** Cobros candidatos para un abono huérfano. */
  bankCandidates(movementId: string): Observable<BankCandidates> {
    return this.http.get<BankCandidates>(`${this.base}/bank/${movementId}/candidates`);
  }
  /** Liga un abono a un cobro elegido (bank-first). */
  linkBank(movementId: string, sucursal: string, folio: string): Observable<any> {
    return this.http.post(`${this.base}/bank/${movementId}/link`, { sucursal, folio });
  }
}
