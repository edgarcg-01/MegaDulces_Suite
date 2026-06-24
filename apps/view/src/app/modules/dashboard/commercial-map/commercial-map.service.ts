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

export interface StoreTopProduct {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  capture_count: number; // en cuántas visitas apareció
  mark_count: number; // veces marcado en total
  last_seen: string | null;
}

export interface StoreTopProducts {
  store_captures: number; // total de visitas de la tienda
  items: StoreTopProduct[];
}

export type ProspectStatus = 'candidate' | 'covered' | 'dismissed' | 'converted';

export interface Prospect {
  id: string;
  nombre: string;
  razon_social: string | null;
  scian: string | null;
  estrato: string | null;
  tipo: string | null;
  lat: number | null;
  lng: number | null;
  direccion: string;
  municipio: string | null;
  entidad: string | null;
  telefono: string | null;
  email: string | null;
  web: string | null;
  status: ProspectStatus;
  nearest_customer_m: number | null;
  whitespace_score: number | null;
}

export interface ProspectListResponse {
  total: number;
  enabled: boolean;
  prospects: Prospect[];
}

export interface ProspectFilters {
  status?: ProspectStatus;
  scian?: string;
  min_score?: number;
  limit?: number;
}

export interface IngestResult {
  enabled: boolean;
  fetched: number;
  matched_scian?: number;
  upserted: number;
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

  /** Productos más frecuentes de la tienda (desde productosMarcados de sus capturas). */
  getStoreTopProducts(storeId: string): Observable<StoreTopProducts> {
    return this.http.get<StoreTopProducts>(`${this.base}/stores/${storeId}/top-products`);
  }

  // ── Prospección DENUE (tiendas de oportunidad) ───────────────────────────

  listProspects(filters: ProspectFilters = {}): Observable<ProspectListResponse> {
    let params = new HttpParams();
    if (filters.status) params = params.set('status', filters.status);
    if (filters.scian) params = params.set('scian', filters.scian);
    if (filters.min_score != null) params = params.set('min_score', String(filters.min_score));
    if (filters.limit != null) params = params.set('limit', String(filters.limit));
    return this.http.get<ProspectListResponse>(`${this.base}/prospects`, { params });
  }

  /** Cosecha POIs DENUE a ≤radius de un punto (prospección en vivo) + dedup. */
  ingestNearby(lat: number, lng: number, radius?: number): Observable<IngestResult> {
    return this.http.post<IngestResult>(`${this.base}/prospects/ingest-nearby`, { lat, lng, radius });
  }

  /** Cosecha sistemática DENUE por entidad+SCIAN (robusta, geocercada por config) + dedup. */
  ingestArea(entidad?: string, municipio?: string): Observable<IngestResult> {
    return this.http.post<IngestResult>(`${this.base}/prospects/ingest-area`, { entidad, municipio });
  }

  dismissProspect(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/prospects/${id}/dismiss`, {});
  }

  convertProspect(id: string, customer_id?: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`${this.base}/prospects/${id}/convert`, { customer_id });
  }
}
