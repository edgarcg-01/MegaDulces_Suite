import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  PresaleReviewDetail,
  PresaleReviewFinishRequest,
  PresaleReviewFinishResponse,
  PresaleReviewInboxResponse,
  PresaleReviewSearchResponse,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[MCP.10]` Revisión en caja de los pedidos de preventa surtidos. */
@Injectable({ providedIn: 'root' })
export class PresaleReviewService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/presale-review`;

  /** `[MCP.24]` Sin `date`, la bandeja viva; con `date` (`YYYY-MM-DD`), lo surtido ese día, revisado o no. */
  inbox(date?: string): Observable<PresaleReviewInboxResponse> {
    return this.http.get<PresaleReviewInboxResponse>(this.base, date ? { params: { date } } : {});
  }

  detail(orderId: string): Observable<PresaleReviewDetail> {
    return this.http.get<PresaleReviewDetail>(`${this.base}/${orderId}`);
  }

  /** `[MCP.10.3]` ¿En qué pedido por revisar de mi sucursal está este producto? Código, SKU o nombre. */
  search(q: string): Observable<PresaleReviewSearchResponse> {
    return this.http.get<PresaleReviewSearchResponse>(`${this.base}/search`, { params: { q } });
  }

  finish(orderId: string, body: PresaleReviewFinishRequest): Observable<PresaleReviewFinishResponse> {
    return this.http.post<PresaleReviewFinishResponse>(`${this.base}/${orderId}/finish`, body);
  }
}
