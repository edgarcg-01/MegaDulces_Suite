import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { FichasPublicadas, RevisionBandeja, RevisionDecisionDto, RevisionDecisionRespuesta, RevisionMotivo } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[NP.7.L.3b]` Catálogo digital › Por revisar y `[NP.7.L.5]` › Publicadas: `/api/catalog/fichas`. */
@Injectable({ providedIn: 'root' })
export class CatalogoDigitalService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/catalog/fichas`;

  bandeja(f: { reason?: RevisionMotivo | null; limit?: number; offset?: number }): Observable<RevisionBandeja> {
    let p = new HttpParams().set('limit', String(f.limit ?? 30)).set('offset', String(f.offset ?? 0));
    if (f.reason) p = p.set('reason', f.reason);
    return this.http.get<RevisionBandeja>(`${this.base}/revision`, { params: p });
  }

  decidir(id: string, dto: RevisionDecisionDto): Observable<RevisionDecisionRespuesta> {
    return this.http.post<RevisionDecisionRespuesta>(`${this.base}/${id}/decision`, dto);
  }

  /**
   * `[NP.7.L.5]` Las fichas publicadas de toda la red (la más reciente primero, la ordena el servidor) y la
   * medición de UNA sucursal. `q` busca por nombre o SKU en el servidor: la lista se pagina y una búsqueda
   * sobre la página cargada contaría sólo lo que ya bajó.
   */
  publicadas(f: { q?: string | null; limit?: number; offset?: number }): Observable<FichasPublicadas> {
    let p = new HttpParams().set('limit', String(f.limit ?? 30)).set('offset', String(f.offset ?? 0));
    const q = (f.q ?? '').trim();
    if (q) p = p.set('q', q);
    return this.http.get<FichasPublicadas>(`${this.base}/publicadas`, { params: p });
  }
}
