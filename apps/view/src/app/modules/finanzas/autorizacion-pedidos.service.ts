import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { BandejaAutorizacion } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[GP.A.4]` La bandeja «Por autorizar» de Crédito y cobranza (anexo EA de GP, §3.6). Sólo lectura: autorizar desde
 * la Suite llega con GP.A.2. Servicio propio para no mezclarlo con el de Cartera.
 */
@Injectable({ providedIn: 'root' })
export class AutorizacionPedidosService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/finance/receivables/autorizacion-pedidos`;

  bandeja(sucursal?: string): Observable<BandejaAutorizacion> {
    const params = sucursal ? new HttpParams().set('sucursal', sucursal) : undefined;
    return this.http.get<BandejaAutorizacion>(this.url, { params });
  }
}
