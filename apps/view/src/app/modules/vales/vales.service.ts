import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { CambiosTrabajoVale, FirmarVale, ListaVales, NuevoVale, ValeDetalle } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[MDT.3.4]` Vale de servicio (`/work-orders`). Lo que cada quien ve y puede hacer lo decide el servidor. */
@Injectable({ providedIn: 'root' })
export class ValesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/work-orders`;

  lista(scope?: string | null, q?: string | null): Observable<ListaVales> {
    let params = new HttpParams();
    if (scope) params = params.set('scope', scope);
    if (q) params = params.set('q', q);
    return this.http.get<ListaVales>(this.base, { params });
  }

  detalle(id: string): Observable<ValeDetalle> {
    return this.http.get<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}`);
  }

  responsables(q?: string | null): Observable<{ id: string; nombre: string; puesto: string | null }[]> {
    return this.http.get<{ id: string; nombre: string; puesto: string | null }[]>(`${this.base}/assignees`, {
      params: q ? new HttpParams().set('q', q) : undefined,
    });
  }

  crear(body: NuevoVale): Observable<ValeDetalle> {
    return this.http.post<ValeDetalle>(this.base, body);
  }

  tomar(id: string): Observable<ValeDetalle> {
    return this.http.post<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}/take`, {});
  }

  asignar(id: string, userId: string): Observable<ValeDetalle> {
    return this.http.post<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}/assign`, { user_id: userId });
  }

  guardar(id: string, body: CambiosTrabajoVale): Observable<ValeDetalle> {
    return this.http.patch<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}`, body);
  }

  completar(id: string, body: CambiosTrabajoVale): Observable<ValeDetalle> {
    return this.http.post<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}/complete`, body);
  }

  cancelar(id: string, reason: string): Observable<ValeDetalle> {
    return this.http.post<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}/cancel`, { reason });
  }

  reabrir(id: string, reason: string): Observable<ValeDetalle> {
    return this.http.post<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}/reopen`, { reason });
  }

  firmar(id: string, body: FirmarVale): Observable<ValeDetalle> {
    return this.http.post<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}/signatures`, body);
  }

  quitarFirma(id: string, firmaId: string): Observable<ValeDetalle> {
    return this.http.delete<ValeDetalle>(`${this.base}/${encodeURIComponent(id)}/signatures/${encodeURIComponent(firmaId)}`);
  }
}
