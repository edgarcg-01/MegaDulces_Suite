import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.5 — cliente de conciliación PUE/PPD↔REP + CFDI↔póliza. /fiscal/conciliacion. */

export interface PpdRow {
  uuid: string; emisor_rfc: string | null; emisor_nombre: string | null; receptor_rfc: string | null;
  rol: string | null; fecha: string | null; total: number | string; moneda: string | null;
  pagado: number | string; saldo: number | string; num_pagos: number;
}
export interface ConciliacionStats {
  ppd_total: number; ppd_sin_rep: number; con_saldo: number; saldo_total: number; monto_total: number;
}
export interface CruceStats {
  cfdi_sin_poliza: number; cfdi_sin_poliza_monto: number; poliza_sin_cfdi: number; poliza_sin_cfdi_monto: number;
}
export interface CfdiSinPoliza { uuid: string; emisor_rfc: string | null; emisor_nombre: string | null; fecha: string | null; total: number | string; metodo_pago: string | null; }
export interface PolizaSinCfdi { sucursal: string; doc_tipo: string; doc_folio: string; rfc: string | null; beneficiario: string | null; fecha: string | null; importe: number | string; }

@Injectable({ providedIn: 'root' })
export class ConciliacionService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/conciliacion`;

  stats(): Observable<ConciliacionStats> { return this.http.get<ConciliacionStats>(`${this.base}/stats`); }
  ppdSinRep(): Observable<PpdRow[]> { return this.http.get<PpdRow[]>(`${this.base}/ppd-sin-rep`); }
  saldoInsoluto(): Observable<PpdRow[]> { return this.http.get<PpdRow[]>(`${this.base}/saldo-insoluto`); }

  cruceStats(): Observable<CruceStats> { return this.http.get<CruceStats>(`${this.base}/cruce/stats`); }
  cfdiSinPoliza(): Observable<CfdiSinPoliza[]> { return this.http.get<CfdiSinPoliza[]>(`${this.base}/cruce/cfdi-sin-poliza`); }
  polizaSinCfdi(): Observable<PolizaSinCfdi[]> { return this.http.get<PolizaSinCfdi[]>(`${this.base}/cruce/poliza-sin-cfdi`); }
}
