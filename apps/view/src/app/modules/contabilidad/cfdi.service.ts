import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.4.2 — cliente del almacén de CFDI 4.0. Consume /fiscal/cfdi. Operations. */

export interface CfdiRow {
  id: string; uuid: string; tipo_comprobante: string | null; serie: string | null; folio: string | null;
  fecha: string | null; emisor_rfc: string | null; emisor_nombre: string | null;
  receptor_rfc: string | null; receptor_nombre: string | null; total: number | string | null;
  moneda: string | null; metodo_pago: string | null; forma_pago: string | null;
  rol: string | null; estatus_sat: string;
  has_xml?: boolean;
}

export interface CfdiListResult { total: number; limit: number; offset: number; rows: CfdiRow[]; }

export interface CfdiStats {
  total: number; monto: number; iva: number;
  porTipo: { tipo_comprobante: string | null; n: string; total: string }[];
  porMetodo: { metodo_pago: string | null; n: string; total: string }[];
}

export interface CfdiFilters {
  from?: string; to?: string; emisor_rfc?: string; receptor_rfc?: string;
  tipo?: string; metodo_pago?: string; rol?: string; estatus_sat?: string; search?: string;
  limit?: number; offset?: number;
}

@Injectable({ providedIn: 'root' })
export class CfdiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/cfdi`;

  private qs(f: CfdiFilters): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v != null && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? '?' + s : '';
  }

  list(f: CfdiFilters = {}): Observable<CfdiListResult> { return this.http.get<CfdiListResult>(`${this.base}${this.qs(f)}`); }
  stats(f: CfdiFilters = {}): Observable<CfdiStats> { return this.http.get<CfdiStats>(`${this.base}/stats${this.qs(f)}`); }
  get(id: string): Observable<any> { return this.http.get(`${this.base}/${encodeURIComponent(id)}`); }
  /** MAT.0 — XML del documento (recibidas: solo si se guardó al descargar). */
  xml(id: string): Observable<string> { return this.http.get(`${this.base}/${encodeURIComponent(id)}/xml`, { responseType: 'text' }); }
  /** MAT — ZIP con los XML agrupados en carpetas por RFC (+ _index.csv). Mismos filtros. */
  exportZip(f: CfdiFilters = {}): Observable<Blob> { return this.http.get(`${this.base}/export.zip${this.qs(f)}`, { responseType: 'blob' }); }
}
