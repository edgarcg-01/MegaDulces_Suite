import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';

interface GpsPt {
  lat: number;
  lng: number;
  ts: number;
  acc: number | null;
}

export interface SnappedStop {
  lat: number;
  lng: number;
  arrived: string;
  left: string;
  minutes: number;
  store_id?: string | null;
  store_name?: string | null;
}

export interface SnappedTrack {
  geometry: { type: 'LineString'; coordinates: [number, number][] };
  distance_m: number;
  point_count: number;
  confidence: number | null;
  stops: SnappedStop[];
  cached: boolean;
}

/**
 * R.1/R.2 — Historial de ruta "por calles". Toma los breadcrumbs GPS crudos de
 * un vendedor en un día y los pega a la red de calles (Mapbox Map Matching),
 * cacheando el resultado en public.route_snapped_tracks (el recorrido de un día
 * pasado es inmutable → se calcula una vez). Además detecta paradas (dwell) y
 * las nombra por geofence contra las tiendas. El proveedor es intercambiable:
 * solo `matchChunk` habla con Mapbox.
 */
@Injectable()
export class MapMatchingService {
  private readonly logger = new Logger(MapMatchingService.name);
  private readonly token = process.env.MAPBOX_TOKEN || '';

  // Límites del map-matching y de la detección de paradas.
  private static readonly MAX_COORDS_PER_REQ = 100; // tope duro de Mapbox /match
  private static readonly MAX_INPUT_POINTS = 1000; // downsample si el día trae más
  private static readonly STOP_RADIUS_M = 40; // radio para considerar "quieto"
  private static readonly STOP_MIN_MINUTES = 5; // dwell mínimo para contar parada
  private static readonly GEOFENCE_M = 90; // cercanía parada↔tienda para nombrarla

  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /** Geometría pegada a calles + paradas para (tenant, user, día). Cachea. */
  async getSnappedTrack(
    tenantId: string,
    userId: string,
    day: string,
    routeId?: string | null,
  ): Promise<SnappedTrack | null> {
    // El día de HOY es parcial (el vendedor sigue moviéndose) → no se cachea, se
    // recomputa siempre. Días pasados son inmutables → caché.
    const todayMx = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const isToday = day === todayMx;

    const cached = isToday
      ? null
      : await this.knex('public.route_snapped_tracks')
          .where({ tenant_id: tenantId, user_id: userId, day })
          .modify((q) => {
            if (routeId) q.where('route_id', routeId);
            else q.whereNull('route_id');
          })
          .first();
    if (cached) {
      return {
        geometry: cached.geometry,
        distance_m: Number(cached.distance_m) || 0,
        point_count: cached.point_count || 0,
        confidence: cached.confidence != null ? Number(cached.confidence) : null,
        stops: cached.stops || [],
        cached: true,
      };
    }

    const pings = await this.knex('public.route_location_pings')
      .where({ tenant_id: tenantId, user_id: userId })
      .whereRaw("DATE(captured_at AT TIME ZONE 'America/Mexico_City') = ?", [day])
      .modify((q) => { if (routeId) q.where('route_id', routeId); })
      .orderBy('captured_at', 'asc')
      .select('lat', 'lng', 'captured_at', 'accuracy_m');
    if (pings.length < 2) return null;

    const mapped: GpsPt[] = pings.map((p: any) => ({
      lat: Number(p.lat),
      lng: Number(p.lng),
      ts: new Date(p.captured_at).getTime(),
      acc: p.accuracy_m != null ? Number(p.accuracy_m) : null,
    }));
    const pts = MapMatchingService.downsample(mapped, MapMatchingService.MAX_INPUT_POINTS);

    // Map-matching por chunks de ≤100 puntos (con solape de 1 para empalmar).
    const coords: [number, number][] = [];
    let distance = 0;
    let confSum = 0;
    let confN = 0;
    for (let i = 0; i < pts.length; i += MapMatchingService.MAX_COORDS_PER_REQ - 1) {
      const chunk = pts.slice(i, i + MapMatchingService.MAX_COORDS_PER_REQ);
      if (chunk.length < 2) break;
      const matched = await this.matchChunk(chunk);
      if (matched) {
        distance += matched.distance;
        if (matched.confidence != null) { confSum += matched.confidence; confN++; }
        const seg = matched.coordinates;
        for (const c of seg) {
          if (coords.length && coords[coords.length - 1][0] === c[0] && coords[coords.length - 1][1] === c[1]) continue;
          coords.push(c);
        }
      } else {
        // Falló el chunk: caer a la línea cruda (mantiene el trazo continuo).
        for (const p of chunk) {
          const c: [number, number] = [p.lng, p.lat];
          if (coords.length && coords[coords.length - 1][0] === c[0] && coords[coords.length - 1][1] === c[1]) continue;
          coords.push(c);
        }
      }
    }
    if (coords.length < 2) return null;

    const stops = await this.detectStops(tenantId, pts);
    const result: SnappedTrack = {
      geometry: { type: 'LineString', coordinates: coords },
      distance_m: Math.round(distance),
      point_count: pts.length,
      confidence: confN ? confSum / confN : null,
      stops,
      cached: false,
    };

    // Solo se cachean días pasados (inmutables). DO NOTHING evita choque si dos
    // requests computaron a la vez (el día pasado da el mismo resultado).
    if (!isToday) {
      await this.knex('public.route_snapped_tracks')
        .insert({
          tenant_id: tenantId,
          user_id: userId,
          route_id: routeId || null,
          day,
          geometry: JSON.stringify(result.geometry),
          distance_m: result.distance_m,
          point_count: result.point_count,
          confidence: result.confidence,
          stops: JSON.stringify(result.stops),
          provider: 'mapbox',
        })
        .onConflict()
        .ignore();
    }

    return result;
  }

  /** Llama a Mapbox Map Matching para un chunk (≤100 puntos). null si falla. */
  private async matchChunk(
    chunk: { lat: number; lng: number; ts: number; acc: number | null }[],
  ): Promise<{ coordinates: [number, number][]; distance: number; confidence: number | null } | null> {
    if (!this.token) {
      this.logger.warn('MAPBOX_TOKEN no configurada — map-matching deshabilitado');
      return null;
    }
    const coordStr = chunk.map((p) => `${p.lng},${p.lat}`).join(';');
    const radiuses = chunk.map((p) => Math.min(50, Math.max(5, Math.round(p.acc ?? 10)))).join(';');
    const timestamps = chunk.map((p) => Math.floor(p.ts / 1000)).join(';');
    const url =
      `https://api.mapbox.com/matching/v5/mapbox/driving/${coordStr}` +
      `?geometries=geojson&overview=full&tidy=true&radiuses=${radiuses}&timestamps=${timestamps}` +
      `&access_token=${this.token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(`Mapbox match HTTP ${res.status}`);
        return null;
      }
      const json: any = await res.json();
      const m = json?.matchings?.[0];
      if (json?.code !== 'Ok' || !m?.geometry?.coordinates?.length) return null;
      return {
        coordinates: m.geometry.coordinates as [number, number][],
        distance: Number(m.distance) || 0,
        confidence: m.confidence != null ? Number(m.confidence) : null,
      };
    } catch (e: any) {
      this.logger.warn(`Mapbox match error: ${e?.message || e}`);
      return null;
    }
  }

  /** Paradas (dwell > umbral) + geofence contra tiendas del tenant. */
  private async detectStops(
    tenantId: string,
    pts: { lat: number; lng: number; ts: number }[],
  ): Promise<SnappedStop[]> {
    const raw = MapMatchingService.computeStops(pts);
    if (raw.length === 0) return [];

    const stores = await this.knex('stores')
      .where('tenant_id', tenantId)
      .whereNotNull('latitud')
      .whereNull('deleted_at')
      .select('id', 'nombre', 'latitud', 'longitud');
    const storeList = stores.map((s: any) => ({
      id: s.id,
      name: s.nombre,
      lat: Number(s.latitud),
      lng: Number(s.longitud),
    }));

    for (const stop of raw) {
      let best: { id: string; name: string } | null = null;
      let bestD = MapMatchingService.GEOFENCE_M;
      for (const st of storeList) {
        const d = MapMatchingService.haversineM(stop.lat, stop.lng, st.lat, st.lng);
        if (d <= bestD) { bestD = d; best = { id: st.id, name: st.name }; }
      }
      stop.store_id = best?.id ?? null;
      stop.store_name = best?.name ?? null;
    }
    return raw;
  }

  /** Detecta paradas: corridas de pings dentro de STOP_RADIUS_M por >= STOP_MIN_MINUTES. */
  private static computeStops(pts: { lat: number; lng: number; ts: number }[]): SnappedStop[] {
    const stops: SnappedStop[] = [];
    let i = 0;
    while (i < pts.length) {
      let j = i + 1;
      while (
        j < pts.length &&
        MapMatchingService.haversineM(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) <= MapMatchingService.STOP_RADIUS_M
      ) {
        j++;
      }
      const runEnd = j - 1;
      const minutes = (pts[runEnd].ts - pts[i].ts) / 60000;
      if (runEnd > i && minutes >= MapMatchingService.STOP_MIN_MINUTES) {
        let latSum = 0, lngSum = 0;
        for (let k = i; k <= runEnd; k++) { latSum += pts[k].lat; lngSum += pts[k].lng; }
        const n = runEnd - i + 1;
        stops.push({
          lat: latSum / n,
          lng: lngSum / n,
          arrived: new Date(pts[i].ts).toISOString(),
          left: new Date(pts[runEnd].ts).toISOString(),
          minutes: Math.round(minutes),
        });
        i = j;
      } else {
        i++;
      }
    }
    return stops;
  }

  /** Downsample uniforme a un máximo de puntos (conserva primero y último). */
  private static downsample<T>(arr: T[], max: number): T[] {
    if (arr.length <= max) return arr;
    const step = arr.length / max;
    const out: T[] = [];
    for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
    if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
    return out;
  }

  private static haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
}
