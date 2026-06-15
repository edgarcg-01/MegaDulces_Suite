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
    ruta: string;
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

export interface PresenceVisit {
  capture_id: string;
  folio: string;
  fecha: string | null;
  hora_inicio: string;
  usuario: string;
  matchedProducts: string[];
  matchedCount: number;
}

export interface PresenceStore {
  id: string;
  nombre: string;
  ruta: string;
  zona: string;
  lat: number | null;
  lng: number | null;
  located: boolean;
  visitCount: number;
  lastSeen: string | null;
  visits: PresenceVisit[];
}

export interface ProductPresence {
  products: { id: string; nombre: string; brand_name: string }[];
  stores: PresenceStore[];
  totalStores: number;
  totalVisits: number;
}

export interface ProductOption {
  id: string;
  nombre: string;
  sku: string;
  brand_name: string;
}

/** Respuesta del matcher IA (Fase K) — solo los campos que usamos acá. */
export interface AiMatchResponse {
  items: Array<{
    suggested: {
      product_id: string;
      product_name?: string;
      brand_name?: string;
      confidence: string;
    } | null;
    alternatives?: Array<{
      product_id: string;
      product_name?: string;
      brand_name?: string;
    }>;
  }>;
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

  /** Superbuscador: tiendas + visitas donde aparece un producto (por `q` o `product_ids`). */
  productPresence(p: {
    q?: string;
    product_ids?: string[];
    date_from?: string;
    date_to?: string;
  }): Observable<ProductPresence> {
    let params = new HttpParams();
    if (p.q) params = params.set('q', p.q);
    if (p.product_ids?.length) params = params.set('product_ids', p.product_ids.join(','));
    if (p.date_from) params = params.set('date_from', p.date_from);
    if (p.date_to) params = params.set('date_to', p.date_to);
    return this.http.get<ProductPresence>(`${this.base}/product-presence`, { params });
  }

  /** Autocomplete: productos que coinciden con el texto (contains). */
  productSearch(q: string): Observable<ProductOption[]> {
    const params = new HttpParams().set('q', q);
    return this.http.get<ProductOption[]>(`${this.base}/product-search`, { params });
  }

  /** Interpreta un texto libre → productos del catálogo (matcher IA Fase K). */
  aiMatch(rawText: string): Observable<AiMatchResponse> {
    return this.http.post<AiMatchResponse>(
      `${environment.apiUrl}/ai/products/match-ai`,
      { rawText },
    );
  }
}
