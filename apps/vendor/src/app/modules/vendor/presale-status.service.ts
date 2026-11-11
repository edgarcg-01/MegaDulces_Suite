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

  /** `[MCP.20]` Con `date` (`YYYY-MM-DD`): los pedidos que levanté ese día. Sin él: lo agendado de cualquier día. */
  status(date?: string): Observable<PresaleSellerStatusResponse> {
    return this.http.get<PresaleSellerStatusResponse>(this.base, date ? { params: { date } } : {});
  }

  unseen(): Observable<{ unseen_reports: number }> {
    return this.http.get<{ unseen_reports: number }>(`${this.base}/unseen`);
  }

  /** `[MCP.20]` Con `orderIds`, sólo los reportes de esos pedidos (los del día en pantalla). */
  markSeen(orderIds?: readonly string[]): Observable<{ updated: number }> {
    return this.http.post<{ updated: number }>(`${this.base}/seen`, orderIds ? { order_ids: [...orderIds] } : {});
  }
}
