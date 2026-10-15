import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  PresalePickDetail,
  PresalePickFinishRequest,
  PresalePickFinishResponse,
  PresalePickInboxResponse,
  PresalePickInboxRow,
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
}
