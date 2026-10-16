import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { PresaleSellerStatusResponse } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[MCP.8]` El avance de los pedidos de preventa de la vendedora: si ya los surtieron, si faltó
 * algo y si Kepler ya los cobró. Archivo aparte de `vendor.service.ts` a propósito: es otra
 * dependencia del servidor y así una sesión que toque la toma de pedido no choca con ésta.
 */
@Injectable({ providedIn: 'root' })
export class PresaleStatusService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/vendor/presale-status`;

  status(): Observable<PresaleSellerStatusResponse> {
    return this.http.get<PresaleSellerStatusResponse>(this.base);
  }

  unseen(): Observable<{ unseen_reports: number }> {
    return this.http.get<{ unseen_reports: number }>(`${this.base}/unseen`);
  }

  markSeen(): Observable<{ updated: number }> {
    return this.http.post<{ updated: number }>(`${this.base}/seen`, {});
  }
}
