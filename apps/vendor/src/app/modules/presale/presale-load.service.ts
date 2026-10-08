import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { PresaleFieldResponse } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[MCP.5]` Pescar pedidos de preventa desde el celular (repartidor o vendedor).
 * API en `libs/commercial/src/lib/presale-control/load-guide.controller.ts` (`/field/presale`).
 */
@Injectable({ providedIn: 'root' })
export class PresaleLoadService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/field/presale`;

  campo(): Observable<PresaleFieldResponse> {
    return this.http.get<PresaleFieldResponse>(this.base);
  }

  cargar(orderIds: string[]): Observable<PresaleFieldResponse> {
    return this.http.post<PresaleFieldResponse>(`${this.base}/load`, { order_ids: orderIds });
  }

  quitar(orderId: string): Observable<PresaleFieldResponse> {
    return this.http.post<PresaleFieldResponse>(`${this.base}/unload`, { order_id: orderId });
  }
}
