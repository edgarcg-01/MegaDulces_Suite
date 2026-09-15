import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * GX.9 — lado interno: la bandeja de capturas de campo sin casar, y los links emitidos.
 * Con sesión y permisos normales (a diferencia de `CapturaGastoService`, que es la pública).
 */

/** Una captura de campo todavía sin folio de Kepler. */
export interface CapturaSinFolio {
  id: string;
  solicitante: string;
  sucursal: string | null;
  sucursal_nombre: string | null;
  proveedor: string;
  importe: number;
  fecha_gasto: string | null;
  comentarios: string | null;
  clasificacion: string | null;
  status: string;
  origen: string;
  monto_ocr: number | null;
  monto_match: boolean | null;
  revision_nota: string | null;
  fotos: number;
  tiene_solicitud: boolean;
  /** 'live' = la foto se tomó con la cámara en vivo; 'file' = salió del selector. */
  camara: 'live' | 'file' | null;
  captured_at: string | null;
  created_at: string;
}

export interface CapturasSinFolioReport {
  kpis: { total: number; importe: number; por_link: number; no_cuadran: number };
  rows: CapturaSinFolio[];
}

export interface CaptureLink {
  id: string;
  persona: string;
  sucursal: string | null;
  nota: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  uses: number;
  capturas: number;
  sin_casar: number;
  vigente: boolean;
  url: string;
  token: string;
  created_by: string | null;
  created_at: string;
}

@Injectable({ providedIn: 'root' })
export class CapturasSinFolioService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/expenses`;

  sinFolio(search?: string): Observable<CapturasSinFolioReport> {
    let params = new HttpParams();
    if (search?.trim()) params = params.set('search', search.trim());
    return this.http.get<CapturasSinFolioReport>(`${this.base}/proofs/sin-folio`, { params });
  }

  /** Liga la captura con su solicitud XA1501 y devuelve los dos importes para compararlos. */
  match(id: string, folio: string): Observable<{ id: string; folio_solicitud: string; importe_declarado: number; importe_kepler: number }> {
    return this.http.post<{ id: string; folio_solicitud: string; importe_declarado: number; importe_kepler: number }>(
      `${this.base}/proofs/${id}/match`, { folio });
  }

  /** Reusa el buscador de solicitudes que ya existía para la captura interna. */
  buscarSolicitudes(q: string) {
    const params = new HttpParams().set('q', q).set('limit', '10');
    return this.http.get<{ folio: string; fecha: string | null; importe: number; beneficiario: string | null; sucursal: string | null; solicitante: string | null }[]>(
      `${this.base}/proofs/search-solicitudes`, { params });
  }

  links(): Observable<CaptureLink[]> {
    return this.http.get<CaptureLink[]>(`${this.base}/capture-links`);
  }
  issueLink(body: { persona: string; sucursal?: string; nota?: string }): Observable<CaptureLink> {
    return this.http.post<CaptureLink>(`${this.base}/capture-links`, body);
  }
  revokeLink(id: string): Observable<{ id: string; persona: string }> {
    return this.http.delete<{ id: string; persona: string }>(`${this.base}/capture-links/${id}`);
  }
}
