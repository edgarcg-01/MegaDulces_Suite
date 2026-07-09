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

/** Repartidor asignable = USUARIO con rol repartidor (dominio Reparto, no flota logística). */
export interface Rider { rider_user_id: string; username: string; full_name: string; warehouse_code?: string | null; }
export interface FleetVehicle { id: string; plate: string; brand?: string; model?: string; capacity_boxes?: number | null; status?: string; }

/** Entrega despachada, para el tracking del usuario de tienda. */
export interface DispatchedDelivery {
  delivery_id: string;
  folio: string;
  status: 'pendiente' | 'entregado' | 'no_entregado' | 'rechazado';
  customer_name: string;
  phone?: string | null;
  delivery_address?: { street?: string; references?: string } | null;
  kepler_folio?: string | null;
  kepler_warehouse_code?: string | null;
  collect_on_delivery?: boolean;
  amount_to_collect?: number | string | null;
  incident_type?: string | null;
  dispatched_at: string;
  delivered_at?: string | null;
  rider_user_id?: string | null;
  rider_name?: string | null;
  rider_username?: string | null;
  order_code?: string | null;
}

export interface DispatchFromKeplerPayload {
  folio: string;
  serie?: string;
  warehouse_code: string;
  rider_user_id: string;
  vehicle_id?: string;
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

  /** Repartidores asignables (usuarios con rol repartidor; opcional scope por sucursal). */
  listRiders(warehouseCode?: string): Observable<Rider[]> {
    let p = new HttpParams();
    if (warehouseCode) p = p.set('warehouse_code', warehouseCode);
    return this.http.get<Rider[]>(`${this.api}/commercial/home-delivery/riders`, { params: p });
  }

  /** Tracking de tienda: entregas despachadas del día con su estado. */
  listDispatched(opts: { warehouse_code?: string; date?: string; status?: string } = {}): Observable<DispatchedDelivery[]> {
    let p = new HttpParams();
    if (opts.warehouse_code) p = p.set('warehouse_code', opts.warehouse_code);
    if (opts.date) p = p.set('date', opts.date);
    if (opts.status) p = p.set('status', opts.status);
    return this.http.get<DispatchedDelivery[]>(`${this.api}/commercial/home-delivery/dispatched`, { params: p });
  }

  listVehicles(): Observable<FleetVehicle[]> {
    return this.http.get<FleetVehicle[]>(`${this.api}/logistics/fleet/vehicles`, {
      params: new HttpParams().set('active', 'true'),
    });
  }

  /** Última posición conocida de cada repartidor (seed del mapa de tienda). */
  riderPositions(sinceMin?: number): Observable<{ positions: RiderPosition[]; server_now: string }> {
    let p = new HttpParams();
    if (sinceMin) p = p.set('since_min', String(sinceMin));
    return this.http.get<{ positions: RiderPosition[]; server_now: string }>(
      `${this.api}/commercial/home-delivery/rider-positions`, { params: p });
  }

  /** Geocoding directo: texto de dirección → candidatos con coords (Mapbox, sesgo MX). */
  geocode(q: string): Observable<{ results: GeocodeResult[] }> {
    return this.http.get<{ results: GeocodeResult[] }>(`${this.api}/reports/geocode`, {
      params: new HttpParams().set('q', q),
    });
  }

  /** Geocoding inverso: coord → dirección legible (para rellenar la calle al soltar el pin). */
  reverseGeocode(lat: number, lng: number): Observable<{ place_name: string } | null> {
    return this.http.get<{ place_name: string } | null>(`${this.api}/reports/reverse-geocode`, {
      params: new HttpParams().set('lat', String(lat)).set('lng', String(lng)),
    });
  }
}

export interface GeocodeResult { lat: number; lng: number; place_name: string; relevance: number; }

export interface RiderPosition {
  rider_user_id: string;
  username: string;
  full_name: string;
  lat: number | string;
  lng: number | string;
  captured_at: string;
  speed_mps?: number | null;
  accuracy_m?: number | null;
}
