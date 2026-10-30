import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  PresaleReviewDetail,
  PresaleReviewFinishRequest,
  PresaleReviewFinishResponse,
  PresaleReviewInboxResponse,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[MCP.10]` Revisión en caja de los pedidos de preventa surtidos. */
@Injectable({ providedIn: 'root' })
export class PresaleReviewService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/presale-review`;

  inbox(): Observable<PresaleReviewInboxResponse> {
    return this.http.get<PresaleReviewInboxResponse>(this.base);
  }

  detail(orderId: string): Observable<PresaleReviewDetail> {
    return this.http.get<PresaleReviewDetail>(`${this.base}/${orderId}`);
  }

  finish(orderId: string, body: PresaleReviewFinishRequest): Observable<PresaleReviewFinishResponse> {
    return this.http.post<PresaleReviewFinishResponse>(`${this.base}/${orderId}/finish`, body);
  }
}
