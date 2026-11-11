import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { SellerDayRecap } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[MCP.19]` El recuento del día. Sin argumentos es el de quien está en sesión (el vendedor, arriba de
 * «Pedidos»); con `userId`, el de alguien de su equipo (el supervisor, en «Equipo › vendedor»). El
 * servidor decide si se puede: el mismo criterio del monitoreo de visitas.
 */
@Injectable({ providedIn: 'root' })
export class RecuentoDiaService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/vendor/day-recap`;

  dia(date?: string, userId?: string): Observable<SellerDayRecap> {
    let params = new HttpParams();
    if (date) params = params.set('date', date);
    if (userId) params = params.set('user_id', userId);
    return this.http.get<SellerDayRecap>(this.base, { params });
  }
}
