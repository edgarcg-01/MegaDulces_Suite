import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { VisitMonitorResponse } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[MCP.3.7]` Monitoreo de visitas del día (supervisor de ventas). */
@Injectable({ providedIn: 'root' })
export class VisitMonitorService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/vendor-routes/visits/monitor`;

  monitor(date: string, userId?: string | null): Observable<VisitMonitorResponse> {
    let params = new HttpParams().set('date', date);
    if (userId) params = params.set('user_id', userId);
    return this.http.get<VisitMonitorResponse>(this.base, { params });
  }
}
