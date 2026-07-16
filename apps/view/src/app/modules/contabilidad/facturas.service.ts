import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FE — cliente de emisión/timbrado de facturas CFDI 4.0. /fiscal/facturas. Operations. */

export interface IssuerConfig {
  id?: string; rfc: string; tax_name: string; regimen_fiscal: string; cp: string;
  serie?: string | null; pac_provider?: string; is_default?: boolean; active?: boolean;
}
export interface EmittedInvoice {
  id: string; uuid: string; serie: string | null; folio: string | null;
  fecha: string; fecha_timbrado: string | null; receptor_rfc: string | null; receptor_nombre: string | null;
  subtotal: string | number; total_trasladados: string | number; total: string | number;
  metodo_pago: string | null; forma_pago: string | null; estatus_sat: string; source: string;
}
export interface ConceptoInput {
  clave_prod_serv?: string; no_identificacion?: string; descripcion: string;
  cantidad: number; clave_unidad?: string; unidad?: string; valor_unitario: number;
  descuento?: number; objeto_imp?: string; tasa_iva?: number;
}
export interface ReceptorInput {
  rfc: string; nombre: string; regimen_fiscal: string; domicilio_cp: string; uso_cfdi: string;
}
export interface EmitirFacturaInput {
  tipo: 'global' | 'nominativa'; emisor_rfc?: string; serie?: string;
  forma_pago?: string; metodo_pago?: string; moneda?: string;
  receptor?: ReceptorInput; conceptos: ConceptoInput[]; periodicidad?: string;
}
export interface EmitResult {
  uuid: string; serie: string; folio: string; subtotal: number; iva: number; total: number;
  fecha_timbrado?: string; provider: string;
}

@Injectable({ providedIn: 'root' })
export class FacturasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/facturas`;

  list(q: { from?: string; to?: string; search?: string } = {}): Observable<{ total: number; limit: number; offset: number; rows: EmittedInvoice[] }> {
    let params = new HttpParams();
    if (q.from) params = params.set('from', q.from);
    if (q.to) params = params.set('to', q.to);
    if (q.search) params = params.set('search', q.search);
    return this.http.get<{ total: number; limit: number; offset: number; rows: EmittedInvoice[] }>(this.base, { params });
  }
  issuers(): Observable<IssuerConfig[]> { return this.http.get<IssuerConfig[]>(`${this.base}/issuer`); }
  saveIssuer(body: IssuerConfig): Observable<IssuerConfig> { return this.http.put<IssuerConfig>(`${this.base}/issuer`, body); }
  emitir(body: EmitirFacturaInput): Observable<EmitResult> { return this.http.post<EmitResult>(this.base, body); }
  cancelar(uuid: string, motivo?: string): Observable<unknown> { return this.http.post(`${this.base}/${uuid}/cancelar`, { motivo }); }
  getXml(uuid: string): Observable<string> { return this.http.get(`${this.base}/${uuid}/xml`, { responseType: 'text' }); }
  getPdf(uuid: string): Observable<{ pdf_base64: string }> { return this.http.get<{ pdf_base64: string }>(`${this.base}/${uuid}/pdf`); }
  /** FE.6 — factura global de mostrador (endpoint en commercial, no fiscal). */
  globalInvoice(date?: string): Observable<{ issued: boolean; uuid?: string; count: number; total: number }> {
    return this.http.post<{ issued: boolean; uuid?: string; count: number; total: number }>(`${environment.apiUrl}/commercial/orders/global-invoice`, { date: date || null });
  }
}
