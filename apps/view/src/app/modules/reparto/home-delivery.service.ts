import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * Dominio ENTREGA A DOMICILIO (persona de tienda) — captura folio Kepler,
 * ve el pedido y lo asigna a un repartidor. NO es logística (es fulfillment
 * comercial disparado por tienda); habla con /commercial/home-delivery/* y
 * /store/live/ticket-lookup.
 */

export interface KeplerTicket {
  warehouse_code: string;
  warehouse_name: string;
  serie: string;
  folio: string;
  ticket_ts: string;
  total: number;
  forma_pago: string;
  items: { sku?: string; nombre?: string; cant?: number; importe?: number }[];
  already_paid: boolean;
  collect_on_delivery_suggested: boolean;
}

export interface FleetDriver { id: string; full_name: string; roles?: string[]; status?: string; }
export interface FleetVehicle { id: string; plate: string; brand?: string; model?: string; capacity_boxes?: number | null; status?: string; }

export interface DispatchFromKeplerPayload {
  folio: string;
  serie?: string;
  warehouse_code: string;
  driver_id: string;
  vehicle_id: string;
  shipment_date: string;
  delivery_address: { recipient_name?: string; phone?: string; street: string; references?: string; lat?: number; lng?: number };
  collect_on_delivery?: boolean;
  amount_to_collect?: number;
}

@Injectable({ providedIn: 'root' })
export class HomeDeliveryService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.apiUrl;

  /** Busca el ticket de Kepler por folio (líneas + total + forma de pago). */
  ticketLookup(folio: string, warehouse: string, serie?: string): Observable<KeplerTicket> {
    let p = new HttpParams().set('folio', folio).set('warehouse', warehouse);
    if (serie) p = p.set('serie', serie);
    return this.http.get<KeplerTicket>(`${this.api}/store/live/ticket-lookup`, { params: p });
  }

  /** Crea la entrega desde el folio + dirección y la asigna a un repartidor+moto. */
  dispatchFromKepler(payload: DispatchFromKeplerPayload): Observable<any> {
    return this.http.post(`${this.api}/commercial/home-delivery/dispatch-from-kepler`, payload);
  }

  listDrivers(): Observable<FleetDriver[]> {
    return this.http.get<FleetDriver[]>(`${this.api}/logistics/fleet/drivers`, {
      params: new HttpParams().set('active', 'true'),
    });
  }

  listVehicles(): Observable<FleetVehicle[]> {
    return this.http.get<FleetVehicle[]>(`${this.api}/logistics/fleet/vehicles`, {
      params: new HttpParams().set('active', 'true'),
    });
  }
}
