/**
 * Utilidades de trayectoria GPS: distancia, simplificación (Douglas-Peucker) y
 * codificación compacta (Google Encoded Polyline). Puras, sin estado — usadas
 * al consolidar la ruta del día.
 */
export interface TrackPoint {
  lat: number;
  lng: number;
}

const EARTH_R = 6371000;
const toRad = (d: number): number => (d * Math.PI) / 180;

/** Distancia entre dos puntos en metros (Haversine). */
export function haversineM(a: TrackPoint, b: TrackPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Distancia total recorrida de la trayectoria, en metros. */
export function totalDistanceM(points: TrackPoint[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineM(points[i - 1], points[i]);
  return d;
}

/**
 * Douglas-Peucker: conserva solo los puntos significativos que preservan la
 * forma de la ruta dentro de una tolerancia `epsilonM` (metros perpendiculares).
 * La distancia perpendicular se calcula en un plano local equirectangular (exacto
 * a escala de ruta urbana). Iterativo (pila) para no desbordar en rutas largas.
 */
export function douglasPeucker(points: TrackPoint[], epsilonM: number): TrackPoint[] {
  const n = points.length;
  if (n <= 2) return points.slice();

  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;
  const stack: [number, number][] = [[0, n - 1]];

  while (stack.length) {
    const [start, end] = stack.pop() as [number, number];
    let maxDist = 0;
    let idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistanceM(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxDist > epsilonM) {
      keep[idx] = true;
      stack.push([start, idx], [idx, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Distancia perpendicular de p al segmento a→b, en metros (plano local). */
function perpDistanceM(p: TrackPoint, a: TrackPoint, b: TrackPoint): number {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(toRad(a.lat));
  const bx = (b.lng - a.lng) * mPerDegLng;
  const by = (b.lat - a.lat) * mPerDegLat;
  const px = (p.lng - a.lng) * mPerDegLng;
  const py = (p.lat - a.lat) * mPerDegLat;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  let t = (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * bx, py - t * by);
}

/**
 * Google Encoded Polyline Algorithm (precisión 5). Codifica la trayectoria en un
 * string ASCII compacto (~4-6 bytes por punto). Decodificable por Leaflet/Google.
 */
export function encodePolyline(points: TrackPoint[]): string {
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  const enc = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    s += String.fromCharCode(v + 63);
    return s;
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    out += enc(lat - lastLat) + enc(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}
