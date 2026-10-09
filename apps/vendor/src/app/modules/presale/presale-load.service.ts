import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  PresaleDeliverRequest,
  PresaleFieldOrderDetail,
  PresaleFieldResponse,
  PresaleNotDeliveredRequest,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[MCP.5]` Pescar pedidos de preventa desde el celular (repartidor o vendedor).
 * `[MCP.6]` Y entregarlos de conformidad.
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

  /** `[MCP.6]` Un pedido de mi guía para entregarlo: renglones y documentos de Kepler del cliente. */
  detalle(orderId: string): Observable<PresaleFieldOrderDetail> {
    return this.http.get<PresaleFieldOrderDetail>(`${this.base}/orders/${orderId}`);
  }

  /** `[MCP.6]` Entrega de conformidad: documento de Kepler, resultado y lo cobrado. */
  entregar(req: PresaleDeliverRequest): Observable<PresaleFieldResponse> {
    return this.http.post<PresaleFieldResponse>(`${this.base}/deliver`, req);
  }

  /** `[MCP.6]` No se pudo entregar: el pedido queda libre para otro día. */
  noEntregado(req: PresaleNotDeliveredRequest): Observable<PresaleFieldResponse> {
    return this.http.post<PresaleFieldResponse>(`${this.base}/not-delivered`, req);
  }
}
