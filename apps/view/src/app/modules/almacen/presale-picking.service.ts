import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  PresalePickDetail,
  PresalePickFinishRequest,
  PresalePickFinishResponse,
  PresalePickInboxResponse,
  PresalePickInboxRow,
  RouteBatchDetail,
  RouteBatchFinishRequest,
  RouteBatchFinishResponse,
  RouteBatchInboxResponse,
  RouteBatchRow,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[MCP.3]` Bandeja del surtidor de preventa y su surtido pedido por pedido. */
@Injectable({ providedIn: 'root' })
export class PresalePickingService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/presale-picking`;

  inbox(): Observable<PresalePickInboxResponse> {
    return this.http.get<PresalePickInboxResponse>(this.base);
  }

  detail(orderId: string): Observable<PresalePickDetail> {
    return this.http.get<PresalePickDetail>(`${this.base}/${orderId}`);
  }

  start(orderId: string): Observable<PresalePickInboxRow> {
    return this.http.post<PresalePickInboxRow>(`${this.base}/${orderId}/start`, {});
  }

  finish(orderId: string, body: PresalePickFinishRequest): Observable<PresalePickFinishResponse> {
    return this.http.post<PresalePickFinishResponse>(`${this.base}/${orderId}/finish`, body);
  }

  // ── [MCP.3.6] La ruta del vendedor como UN pedido global ──

  /** Las rutas de hoy del alcance del surtidor (en ruta, listas, surtiendo, surtidas). */
  routes(): Observable<RouteBatchInboxResponse> {
    return this.http.get<RouteBatchInboxResponse>(`${this.base}/routes`);
  }

  routeDetail(routeDayId: string): Observable<RouteBatchDetail> {
    return this.http.get<RouteBatchDetail>(`${this.base}/routes/${routeDayId}`);
  }

  routeStart(routeDayId: string): Observable<RouteBatchRow> {
    return this.http.post<RouteBatchRow>(`${this.base}/routes/${routeDayId}/start`, {});
  }

  routeFinish(routeDayId: string, body: RouteBatchFinishRequest): Observable<RouteBatchFinishResponse> {
    return this.http.post<RouteBatchFinishResponse>(`${this.base}/routes/${routeDayId}/finish`, body);
  }
}
