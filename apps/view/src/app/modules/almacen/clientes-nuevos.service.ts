import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  KeplerCustomerLookup,
  LinkKeplerResponse,
  NewCustomersInboxResponse,
  NewCustomersSummary,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[MCP.3.8]` Clientes nuevos de la sucursal por dar de alta en Kepler, y su liga. */
@Injectable({ providedIn: 'root' })
export class ClientesNuevosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/warehouse/new-customers`;

  bandeja(): Observable<NewCustomersInboxResponse> {
    return this.http.get<NewCustomersInboxResponse>(this.base);
  }

  /** Cuántos faltan y qué pedidos son de un cliente sin clave (aviso de Surtir). */
  resumen(): Observable<NewCustomersSummary> {
    return this.http.get<NewCustomersSummary>(`${this.base}/summary`);
  }

  buscarClave(customerId: string, code: string): Observable<KeplerCustomerLookup> {
    return this.http.get<KeplerCustomerLookup>(`${this.base}/${customerId}/kepler`, {
      params: new HttpParams().set('code', code),
    });
  }

  ligar(customerId: string, code: string): Observable<LinkKeplerResponse> {
    return this.http.post<LinkKeplerResponse>(`${this.base}/${customerId}/link`, { erp_customer_code: code });
  }
}
