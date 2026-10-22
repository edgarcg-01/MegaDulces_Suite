import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { SellerRouteDay } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';
import { MX_TZ } from '../../core/utils/mx-date';

/**
 * `[MCP.3.6]` Iniciar y finalizar la ruta del día. Archivo aparte de `vendor.service.ts` para no
 * chocar con quien toque la toma de pedido (mismo criterio que `presale-status.service.ts`).
 */
@Injectable({ providedIn: 'root' })
export class RouteDayService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/vendor/route-day`;

  today(): Observable<SellerRouteDay> {
    return this.http.get<SellerRouteDay>(this.base);
  }

  start(): Observable<SellerRouteDay> {
    return this.http.post<SellerRouteDay>(`${this.base}/start`, {});
  }

  finish(): Observable<SellerRouteDay> {
    return this.http.post<SellerRouteDay>(`${this.base}/finish`, {});
  }
}

const HORA = new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: MX_TZ });

/** `HH:MM` en hora de México; `''` si no hay fecha o no se puede leer. */
export function horaMx(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : HORA.format(d);
}
