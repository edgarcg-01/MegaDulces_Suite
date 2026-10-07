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

/** Filtros que el backend ya acepta (ConciliacionFilters / CruceFilters). `rol` solo aplica a REP. */
export interface ConcFilters { from?: string; to?: string; rfc?: string; rol?: string; limit?: number; offset?: number; }

@Injectable({ providedIn: 'root' })
export class ConciliacionService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/conciliacion`;

  // REP usa `emisor_rfc` + `rol`; Cruce usa `rfc`. Un solo filtro de RFC se mapea al param correcto.
  private qs(f: ConcFilters, rfcParam: 'emisor_rfc' | 'rfc'): string {
    const p = new URLSearchParams();
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    if (f.rfc) p.set(rfcParam, f.rfc);
    if (f.rol && rfcParam === 'emisor_rfc') p.set('rol', f.rol);
    if (f.limit != null) p.set('limit', String(f.limit));
    if (f.offset != null) p.set('offset', String(f.offset));
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  stats(f: ConcFilters = {}): Observable<ConciliacionStats> { return this.http.get<ConciliacionStats>(`${this.base}/stats${this.qs(f, 'emisor_rfc')}`); }
  ppdSinRep(f: ConcFilters = {}): Observable<PpdRow[]> { return this.http.get<PpdRow[]>(`${this.base}/ppd-sin-rep${this.qs(f, 'emisor_rfc')}`); }
  saldoInsoluto(f: ConcFilters = {}): Observable<PpdRow[]> { return this.http.get<PpdRow[]>(`${this.base}/saldo-insoluto${this.qs(f, 'emisor_rfc')}`); }

  cruceStats(f: ConcFilters = {}): Observable<CruceStats> { return this.http.get<CruceStats>(`${this.base}/cruce/stats${this.qs(f, 'rfc')}`); }
  cfdiSinPoliza(f: ConcFilters = {}): Observable<CfdiSinPoliza[]> { return this.http.get<CfdiSinPoliza[]>(`${this.base}/cruce/cfdi-sin-poliza${this.qs(f, 'rfc')}`); }
  polizaSinCfdi(f: ConcFilters = {}): Observable<PolizaSinCfdi[]> { return this.http.get<PolizaSinCfdi[]>(`${this.base}/cruce/poliza-sin-cfdi${this.qs(f, 'rfc')}`); }
}
