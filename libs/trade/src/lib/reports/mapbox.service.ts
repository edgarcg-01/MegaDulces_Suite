import { Injectable, Logger } from '@nestjs/common';

export type LngLat = [number, number];

/**
 * Wrapper de las APIs de Mapbox más allá del map-matching:
 *  - directions: distancia/duración (con tráfico) entre puntos → ETA.
 *  - optimize: orden óptimo de visita (TSP, ≤12 puntos) → secuencia de cartera.
 *  - staticImageUrl: imagen del recorrido pegado a calles para PDF/WhatsApp.
 * Proveedor aislado acá; todo usa MAPBOX_TOKEN.
 */
@Injectable()
export class MapboxService {
  private readonly logger = new Logger(MapboxService.name);
  private readonly token = process.env.MAPBOX_TOKEN || '';

  get enabled(): boolean {
    return !!this.token;
  }

  /** Distancia (m) + duración (s) con tráfico entre una secuencia de puntos. */
  async directions(coords: LngLat[]): Promise<{ distance_m: number; duration_s: number } | null> {
    if (!this.token || coords.length < 2 || coords.length > 25) return null;
    const path = coords.map((c) => `${c[0]},${c[1]}`).join(';');
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${path}` +
      `?overview=false&access_token=${this.token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const j: any = await res.json();
      const r = j?.routes?.[0];
      if (j?.code !== 'Ok' || !r) return null;
      return { distance_m: Math.round(r.distance), duration_s: Math.round(r.duration) };
    } catch (e: any) {
      this.logger.warn(`directions error: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * Orden óptimo de visita (Optimization API). Límite de Mapbox: ≤12 puntos.
   * `roundtrip=true&source=first`: ciclo óptimo que empieza (y cierra) en el
   * primer punto (inicio/base del vendedor) — el único modo soportado por el
   * token (roundtrip=false da NotImplemented). Devuelve el orden de visita
   * (índices del input). null si >12 o falla → el caller usa su solver propio.
   */
  async optimize(
    coords: LngLat[],
  ): Promise<{ order: number[]; distance_m: number; duration_s: number } | null> {
    if (!this.token || coords.length < 2 || coords.length > 12) return null;
    const path = coords.map((c) => `${c[0]},${c[1]}`).join(';');
    const url =
      `https://api.mapbox.com/optimized-trips/v1/mapbox/driving/${path}` +
      `?source=first&roundtrip=true&overview=false&access_token=${this.token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const j: any = await res.json();
      if (j?.code !== 'Ok' || !j?.waypoints || !j?.trips?.[0]) return null;
      // waypoint_index = posición de cada input en el trip óptimo → invertir a orden.
      const order = j.waypoints
        .map((w: any, i: number) => ({ i, wi: w.waypoint_index }))
        .sort((a: any, b: any) => a.wi - b.wi)
        .map((x: any) => x.i);
      return { order, distance_m: Math.round(j.trips[0].distance), duration_s: Math.round(j.trips[0].duration) };
    } catch (e: any) {
      this.logger.warn(`optimize error: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * Geocoding directo (texto → coordenada). Sesga a México y a la región de La
   * Piedad para que "Av. Juárez 123" resuelva local sin estado/país. Devuelve el
   * mejor match con su nombre normalizado, o null.
   */
  async geocodeForward(
    query: string,
    opts?: { proximity?: LngLat; limit?: number },
  ): Promise<{ lat: number; lng: number; place_name: string; relevance: number }[] | null> {
    const q = (query || '').trim();
    if (!this.token || q.length < 3) return null;
    const limit = Math.min(Math.max(opts?.limit ?? 5, 1), 10);
    const prox = opts?.proximity
      ? `&proximity=${opts.proximity[0]},${opts.proximity[1]}`
      : '&proximity=-102.0389,20.3487'; // La Piedad, Mich. por default
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
      `?country=mx&language=es&limit=${limit}&autocomplete=true${prox}&access_token=${this.token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const j: any = await res.json();
      const feats = Array.isArray(j?.features) ? j.features : [];
      return feats
        .filter((f: any) => Array.isArray(f?.center) && f.center.length === 2)
        .map((f: any) => ({
          lng: f.center[0],
          lat: f.center[1],
          place_name: f.place_name || f.text || '',
          relevance: Number(f.relevance) || 0,
        }));
    } catch (e: any) {
      this.logger.warn(`geocodeForward error: ${e?.message || e}`);
      return null;
    }
  }

  /** Geocoding inverso (coordenada → dirección legible). Devuelve place_name o null. */
  async reverseGeocode(lat: number, lng: number): Promise<{ place_name: string } | null> {
    if (!this.token || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
      `?language=es&limit=1&types=address,poi&access_token=${this.token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const j: any = await res.json();
      const f = j?.features?.[0];
      if (!f) return null;
      return { place_name: f.place_name || f.text || '' };
    } catch (e: any) {
      this.logger.warn(`reverseGeocode error: ${e?.message || e}`);
      return null;
    }
  }

  /**
   * URL de imagen estática (Static Images API) con el recorrido como polyline.
   * No hace fetch: devuelve una URL que el PDF/WhatsApp/cliente carga directo.
   * Codifica la geometría en polyline5 (compacto, evita el límite de URL).
   */
  staticImageUrl(coords: LngLat[], opts?: { width?: number; height?: number; color?: string }): string | null {
    if (!this.token || coords.length < 2) return null;
    const w = opts?.width ?? 640;
    const h = opts?.height ?? 400;
    const color = (opts?.color ?? 'f05a28').replace('#', '');
    // muestreo a ≤100 puntos para no exceder la URL aunque sea polyline
    let pts = coords;
    if (pts.length > 100) {
      const step = pts.length / 100;
      const o: LngLat[] = [];
      for (let i = 0; i < pts.length; i += step) o.push(pts[Math.floor(i)]);
      pts = o;
    }
    const poly = encodeURIComponent(MapboxService.encodePolyline(pts));
    return (
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/` +
      `path-4+${color}-0.85(${poly})/auto/${w}x${h}@2x?access_token=${this.token}`
    );
  }

  /**
   * URL de imagen estática con paradas numeradas + (opcional) origen. Para la
   * vista de ruta del repartidor: un pin `pin-s-<n>` por parada en orden de
   * visita. Mapbox limita los overlays por URL, así que se cap a 20 paradas
   * (suficiente para un reparto; más allá el orden se ve igual en la lista).
   */
  staticStopsImageUrl(
    stops: { lat: number; lng: number; label?: string }[],
    opts?: { origin?: LngLat; width?: number; height?: number },
  ): string | null {
    if (!this.token || !stops?.length) return null;
    const w = opts?.width ?? 640;
    const h = opts?.height ?? 420;
    const capped = stops.slice(0, 20);
    const overlays: string[] = [];
    if (opts?.origin) overlays.push(`pin-l-warehouse+2563eb(${opts.origin[0]},${opts.origin[1]})`);
    capped.forEach((s, i) => {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return;
      const label = s.label ?? String(i + 1);
      overlays.push(`pin-s-${encodeURIComponent(label)}+f05a28(${s.lng},${s.lat})`);
    });
    if (!overlays.length) return null;
    return (
      `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/` +
      `${overlays.join(',')}/auto/${w}x${h}@2x?access_token=${this.token}`
    );
  }

  /** Polyline5 (algoritmo de Google) sobre [lng,lat][]. */
  private static encodePolyline(coords: LngLat[]): string {
    let lastLat = 0, lastLng = 0, out = '';
    const enc = (v: number) => {
      let n = v < 0 ? ~(v << 1) : v << 1;
      let s = '';
      while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
      s += String.fromCharCode(n + 63);
      return s;
    };
    for (const [lng, lat] of coords) {
      const la = Math.round(lat * 1e5);
      const ln = Math.round(lng * 1e5);
      out += enc(la - lastLat) + enc(ln - lastLng);
      lastLat = la; lastLng = ln;
    }
    return out;
  }
}
