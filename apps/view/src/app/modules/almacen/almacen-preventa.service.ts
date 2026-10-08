import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams, HttpResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  LoadGuidesResponse,
  PresaleCandidatesResponse,
  PresaleDetail,
  PresaleLinkResponse,
  PresaleListResponse,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[MCP.2]` Cliente de la Mesa de Control de Preventa (`/almacen/pedidos/preventa`).
 * Contrato en `libs/contracts/src/http/warehouse-presale.contract.ts`; API en
 * `libs/commercial/src/lib/presale-control/`.
 */
@Injectable({ providedIn: 'root' })
export class AlmacenPreventaService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/presale`;
  private readonly guias = `${environment.apiUrl}/warehouse/presale-guides`;

  /** Pedidos vivos + cerrados de los últimos `closedDays` días (el servidor usa 7 si no se manda). */
  list(closedDays?: number): Observable<PresaleListResponse> {
    let p = new HttpParams();
    if (closedDays != null) p = p.set('closed_days', String(closedDays));
    return this.http.get<PresaleListResponse>(this.base, { params: p });
  }

  detail(id: string): Observable<PresaleDetail> {
    return this.http.get<PresaleDetail>(`${this.base}/${id}`);
  }

  candidates(id: string): Observable<PresaleCandidatesResponse> {
    return this.http.get<PresaleCandidatesResponse>(`${this.base}/${id}/candidates`);
  }

  link(id: string, folioDigital: string): Observable<PresaleLinkResponse> {
    return this.http.post<PresaleLinkResponse>(`${this.base}/${id}/link`, { folio_digital: folioDigital });
  }

  unlink(id: string, reason: string): Observable<PresaleLinkResponse> {
    return this.http.post<PresaleLinkResponse>(`${this.base}/${id}/unlink`, { reason });
  }

  // ── [MCP.5] Guías de carga (la caja) ─────────────────────────────────────────────────────────

  /** Guías del día (`YYYY-MM-DD`, default hoy) de las sucursales del alcance. */
  listGuides(date?: string): Observable<LoadGuidesResponse> {
    let p = new HttpParams();
    if (date) p = p.set('date', date);
    return this.http.get<LoadGuidesResponse>(this.guias, { params: p });
  }

  /**
   * Imprime (o reimprime) una guía. Llega como blob con su folio en un header: la primera vez la
   * congela el servidor; después devuelve la misma foto marcada REIMPRESIÓN.
   */
  printGuide(id: string): Observable<HttpResponse<Blob>> {
    return this.http.post(`${this.guias}/${id}/print`, {}, { responseType: 'blob', observe: 'response' });
  }
}
