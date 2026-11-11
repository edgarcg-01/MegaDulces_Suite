import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { CotizacionDetalle, Rung } from './cotizacion';
import type { ListaDeCotizaciones } from './mis-cotizaciones';

/**
 * `[MCP.12]` La cotización del vendedor sobre el MISMO servidor que la de telemarketing
 * (`commercial/quotes`, E.12/COT): precios de Kepler por sucursal, cada quien ve sólo las suyas
 * (COT.21), y la sucursal la valida el alcance (COT.19). La app no manda precios: sólo qué y cuánto.
 */
@Injectable({ providedIn: 'root' })
export class VendorQuoteService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/quotes`;

  /** Crea la cotización en borrador. `origin: 'route_visit'` = la levantó el vendedor en su visita. */
  create(body: { customer_id: string; source_branch: string; warehouse_id?: string; contact_phone?: string }): Observable<{ id: string; code: string; valid_until: string }> {
    return this.http.post<{ id: string; code: string; valid_until: string }>(this.base, { ...body, origin: 'route_visit' });
  }

  get(id: string): Observable<CotizacionDetalle> {
    return this.http.get<CotizacionDetalle>(`${this.base}/${id}`);
  }

  addLine(id: string, body: { sku: string; quantity: number; rung: Rung }): Observable<unknown> {
    return this.http.post(`${this.base}/${id}/lines`, body);
  }

  updateLine(id: string, lineId: string, body: { quantity: number; rung: Rung }): Observable<unknown> {
    return this.http.patch(`${this.base}/${id}/lines/${lineId}`, body);
  }

  removeLine(id: string, lineId: string): Observable<unknown> {
    return this.http.delete(`${this.base}/${id}/lines/${lineId}`);
  }

  /**
   * `[MCP.16]` Mis cotizaciones hechas en la app (`mine` + `origin=route_visit`), más nuevas primero.
   * El servidor topa `limit` en 200 y devuelve `total`: la pantalla dice cuántas faltan.
   */
  list(opts: { limit?: number; offset?: number } = {}): Observable<ListaDeCotizaciones> {
    const params = new HttpParams()
      .set('mine', 'true')
      .set('origin', 'route_visit')
      .set('limit', String(opts.limit ?? 50))
      .set('offset', String(opts.offset ?? 0));
    return this.http.get<ListaDeCotizaciones>(this.base, { params });
  }

  /**
   * `[MCP.16]` Con qué sucursales puede cotizar (COT.19). Sólo se pregunta cuando la lista sale vacía:
   * sin sucursal el servidor no deja ver ni hacer cotizaciones, y eso no es «aún no tienes».
   */
  branches(): Observable<{ branches: string[] | null; resolvable: boolean }> {
    return this.http.get<{ branches: string[] | null; resolvable: boolean }>(`${this.base}/branches`);
  }
}
