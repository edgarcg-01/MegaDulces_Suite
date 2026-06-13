import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export type Presence = 'none' | 'own' | 'competitor' | 'both' | 'unknown';

export interface MapStore {
  id: string;
  nombre: string;
  direccion: string | null;
  zona: string;
  ruta: string;
  lat: number | null;
  lng: number | null;
  located: boolean;
  visitas: number;
  ultimaVisita: string | null;
  score: number;
  own: number;
  competitor: number;
  unknown: number;
  presence: Presence;
}

export interface StoresResponse {
  stores: MapStore[];
  total: number;
  unlocatedCount: number;
}

export interface HistoryExhibicion {
  concepto: string;
  ubicacion: string;
  nivel: string;
  score: number | null;
  fotoUrl: string | null;
  perteneceMegaDulces: boolean | null;
  productos: string[];
}

export interface HistoryVisit {
  capture_id: string;
  folio: string;
  fecha: string | null;
  hora_inicio: string;
  hora_fin: string | null;
  usuario: string;
  score: number;
  exhibiciones: HistoryExhibicion[];
}

export interface StoreHistory {
  store: {
    id: string;
    nombre: string;
    direccion: string | null;
    zona: string;
    totalVisitas: number;
    ultimaVisita: string | null;
    diasSinVisita: number | null;
    score: number;
    ownTotal: number;
    competitorTotal: number;
    unknownTotal: number;
  };
  visits: HistoryVisit[];
}

export interface StoresFilters {
  date_from?: string;
  date_to?: string;
  zone_id?: string;
  route_id?: string;
}

@Injectable({ providedIn: 'root' })
export class CommercialMapService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial-map`;

  getStores(filters: StoresFilters = {}): Observable<StoresResponse> {
    let params = new HttpParams();
    if (filters.date_from) params = params.set('date_from', filters.date_from);
    if (filters.date_to) params = params.set('date_to', filters.date_to);
    if (filters.zone_id) params = params.set('zone_id', filters.zone_id);
    if (filters.route_id) params = params.set('route_id', filters.route_id);
    return this.http.get<StoresResponse>(`${this.base}/stores`, { params });
  }

  getStoreHistory(
    id: string,
    filters: { date_from?: string; date_to?: string } = {},
  ): Observable<StoreHistory> {
    let params = new HttpParams();
    if (filters.date_from) params = params.set('date_from', filters.date_from);
    if (filters.date_to) params = params.set('date_to', filters.date_to);
    return this.http.get<StoreHistory>(`${this.base}/stores/${id}/history`, { params });
  }
}
