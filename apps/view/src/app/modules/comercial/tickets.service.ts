import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { TicketVenta } from './ticket-venta';

/**
 * Fase TK.2 — Cliente de `/commercial/tickets`.
 *
 * Servicio propio y no un método más en `ComercialService` (que ya pasa de 850 líneas): esta
 * pantalla habla con un solo controller y su tipo de retorno —`TicketVenta`— es el mismo que
 * consume el generador del ticket térmico, así que conviene que vivan juntos.
 */

export interface TicketCandidato {
  /** Identidad COMPLETA del documento: `03UD1001-0018665` o `PD-2026-00012`. */
  id: string;
  origen: 'mostrador' | 'telemarketing' | 'credito' | 'pedido';
  origen_label: string;
  sucursal: string | null;
  sucursal_nombre: string | null;
  caja: number | null;
  folio: string;
  fecha: string | null;
  cliente_nombre: string | null;
  total: string | null;
}

export interface TicketBusqueda {
  termino: string;
  candidatos: TicketCandidato[];
  /** true ⇒ había más de los que caben: hay que afinar el folio, no scrollear. */
  truncado: boolean;
}

@Injectable({ providedIn: 'root' })
export class TicketsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/tickets`;

  buscar(q: string): Observable<TicketBusqueda> {
    return this.http.get<TicketBusqueda>(this.base, { params: { q } });
  }

  detalle(id: string): Observable<TicketVenta> {
    return this.http.get<TicketVenta>(`${this.base}/${encodeURIComponent(id)}`);
  }

  /**
   * El PDF se pide como **blob** y no abriendo la URL en una pestaña: la ruta va con `Bearer`
   * y una pestaña nueva no lleva el token (mismo patrón que la Guía de Cobranza en AX).
   */
  cartaPdf(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/${encodeURIComponent(id)}/carta.pdf`, { responseType: 'blob' });
  }
}
