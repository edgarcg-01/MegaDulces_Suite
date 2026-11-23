import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { AccionDecisionPedido, BandejaAutorizacion, PedidoPorAutorizar, ResultadoDecisionPedido } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[GP.A.4]` La bandeja «Por autorizar» de Crédito y cobranza (anexo EA de GP, §3.6) y `[GP.A.5]` la decisión que
 * toma sobre un pedido. Servicio propio para no mezclarlo con el de Cartera.
 */
@Injectable({ providedIn: 'root' })
export class AutorizacionPedidosService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/finance/receivables/autorizacion-pedidos`;
  private readonly decisionUrl = `${environment.apiUrl}/finance/autorizacion-pedidos`;

  bandeja(sucursal?: string): Observable<BandejaAutorizacion> {
    const params = sucursal ? new HttpParams().set('sucursal', sucursal) : undefined;
    return this.http.get<BandejaAutorizacion>(this.url, { params });
  }

  /**
   * `[GP.A.5]` Autorizar o rechazar el pedido. El motivo es obligatorio: queda en la bitácora con quién y cuándo.
   * Autorizar escribe `kdm1.c11` en Kepler; rechazar no lo toca (el pedido sigue CREADO) y sólo deja dicho por qué.
   */
  decidir(p: Pick<PedidoPorAutorizar, 'sucursal' | 'serie' | 'folio'>, accion: AccionDecisionPedido, motivo: string): Observable<ResultadoDecisionPedido> {
    const folio = encodeURIComponent(p.folio.trim());
    return this.http.post<ResultadoDecisionPedido>(`${this.decisionUrl}/${p.sucursal}/${p.serie}/${folio}`, { accion, motivo });
  }
}
