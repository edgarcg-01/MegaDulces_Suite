import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type { RevisionBandeja, RevisionDecisionDto, RevisionDecisionRespuesta, RevisionMotivo } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[NP.7.L.3b]` Catálogo digital › Por revisar: `/api/catalog/fichas`. */
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
}
