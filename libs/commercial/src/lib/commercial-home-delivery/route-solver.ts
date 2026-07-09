/**
 * LM.10 — Solver de ruta para entregas a domicilio (dominio Reparto).
 *
 * Función pura, sin dependencias: TSP abierto (parte del origen, visita todas
 * las paradas, NO regresa). nearest-neighbor + 2-opt, distancia = haversine km.
 * Es una copia deliberada del solver de logística (libs/logistics) para no
 * cruzar la frontera Nx entre libs; si algún día se comparte, se extrae a un
 * lib común. Para un reparto (decenas de paradas) es instantáneo.
 */
export interface GeoPoint {
  id: string;
  lat: number;
  lng: number;
}

export interface SolveResult {
  order: string[]; // ids de paradas en orden óptimo de visita
  total_km: number; // origen → ... → última parada
}

const R = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function routeLength(origin: { lat: number; lng: number }, seq: GeoPoint[]): number {
  if (!seq.length) return 0;
  let d = haversineKm(origin, seq[0]);
  for (let i = 1; i < seq.length; i++) d += haversineKm(seq[i - 1], seq[i]);
  return d;
}

function nearestNeighbor(origin: { lat: number; lng: number }, stops: GeoPoint[]): GeoPoint[] {
  const remaining = [...stops];
  const seq: GeoPoint[] = [];
  let cur = origin;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(cur, remaining[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    cur = remaining[best];
    seq.push(remaining.splice(best, 1)[0]);
  }
  return seq;
}

function twoOpt(origin: { lat: number; lng: number }, seq: GeoPoint[]): GeoPoint[] {
  if (seq.length < 4) return seq;
  let best = seq;
  let bestLen = routeLength(origin, best);
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const len = routeLength(origin, candidate);
        if (len + 1e-9 < bestLen) { best = candidate; bestLen = len; improved = true; }
      }
    }
  }
  return best;
}

export function solveOpenRoute(origin: { lat: number; lng: number }, stops: GeoPoint[]): SolveResult {
  const valid = stops.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!valid.length) return { order: [], total_km: 0 };
  const nn = nearestNeighbor(origin, valid);
  const opt = twoOpt(origin, nn);
  return { order: opt.map((s) => s.id), total_km: Math.round(routeLength(origin, opt) * 100) / 100 };
}

/** Centroide simple de un conjunto de puntos (fallback de origen). */
export function centroid(points: { lat: number; lng: number }[]): { lat: number; lng: number } | null {
  const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!valid.length) return null;
  const lat = valid.reduce((s, p) => s + p.lat, 0) / valid.length;
  const lng = valid.reduce((s, p) => s + p.lng, 0) / valid.length;
  return { lat, lng };
}
