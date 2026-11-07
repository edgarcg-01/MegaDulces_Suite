import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { VecinalVendorDetail, VecinalVendorsResponse, VisitMonitorResponse } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[SUP.2]` «Mi equipo hoy» en la app. ⛔ No hay endpoint propio: lee los MISMOS que la web
 * (`[MCP.3.7]` monitor de visitas y `[MV.2]` monitoreo vecinal), para que «quién visitó a quién» y
 * «cuánto se cobró» sean una sola lógica en las dos pantallas.
 */
@Injectable({ providedIn: 'root' })
export class SupervisorEquipoService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  /** El día de su equipo: estado de la ruta y cada cliente (también los no visitados). */
  dia(date: string, userId?: string): Observable<VisitMonitorResponse> {
    let params = new HttpParams().set('date', date);
    if (userId) params = params.set('user_id', userId);
    return this.http.get<VisitMonitorResponse>(`${this.api}/commercial/vendor-routes/visits/monitor`, { params });
  }

  /** Lo levantado, lo cobrado en Kepler y la meta de cada vendedor vecinal ese día. */
  ventas(date: string): Observable<VecinalVendorsResponse> {
    return this.http.get<VecinalVendorsResponse>(`${this.api}/commercial/vecinal-monitor/vendors`, {
      params: new HttpParams().set('from', date).set('to', date),
    });
  }

  /** Un vendedor ese día: qué le levantó y qué le cobró Kepler a cada cliente. */
  ventasDe(userId: string, date: string): Observable<VecinalVendorDetail> {
    return this.http.get<VecinalVendorDetail>(`${this.api}/commercial/vecinal-monitor/vendors/${encodeURIComponent(userId)}`, {
      params: new HttpParams().set('from', date).set('to', date),
    });
  }
}
