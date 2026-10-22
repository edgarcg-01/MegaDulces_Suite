import type {
  VisitMonitorCounts,
  VisitMonitorRow,
  VisitMonitorStatus,
  VisitNoSaleReason,
} from '@megadulces/contracts';

/**
 * `[MCP.3.7]` Protocolo de visitas — las reglas, sin base de datos.
 *
 * Decide el estado de UN cliente en UN día de UN vendedor a partir de tres hechos que ya existen:
 * su visita (si abrió al cliente), sus pedidos de ese día y lo más cerca que pasó según el GPS de la
 * jornada. El orden de las reglas importa y está fijado por las pruebas:
 *
 *  1. Hubo pedido (en la visita o suelto ese día)          → `con_pedido`.
 *  2. Abrió al cliente y cerró sin pedido                  → `sin_pedido` (con motivo).
 *  3. Abrió al cliente y no cerró                          → `abierta`.
 *  4. No lo abrió y la ruta sigue abierta                  → `pendiente` (la falta se juzga al cerrar).
 *  5. No lo abrió y el cliente no tiene ubicación          → `sin_ubicacion` (no se puede saber).
 *  6. No lo abrió y no hubo GPS del vendedor ese día       → `sin_gps` (no se puede saber).
 *  7. No lo abrió y pasó dentro del radio                  → `se_fue_sin_abrir` (falta).
 *  8. No lo abrió y nunca entró al radio                   → `no_paso` (falta).
 *
 * ⛔ 5 y 6 van ANTES que 7 y 8 a propósito: lo que no se midió se declara, nunca se dibuja como falta.
 */

/** Radio de llegada: el mismo que ya usa «clientes cercanos» (`DEFAULT_NEARBY_RADIUS_M`). */
export const VISIT_RADIUS_M = 80;
/** Un punto de GPS con precisión peor que esto no sirve para decir «pasó a 80 m». */
export const VISIT_MAX_ACCURACY_M = 100;

export interface VisitFact {
  visited_at: string | Date;
  ended_at: string | Date | null;
  had_order: boolean;
  had_ticket: boolean;
  no_sale_reason: string | null;
  notes: string | null;
  /** Metros del celular al cliente al abrirlo; `null` si no se pudo medir. */
  distance_m: number | null;
}

export interface VisitCustomerFacts {
  customer_id: string;
  code: string;
  name: string;
  on_route: boolean;
  has_location: boolean;
  /** La visita más reciente del día (la que manda). */
  visit: VisitFact | null;
  /** Le levantó al menos un pedido ese día (no borrador). */
  ordered: boolean;
  /** Lo más cerca que pasó según el GPS del día (`null` = sin puntos útiles o sin ubicación). */
  nearest_m: number | null;
}

export interface VisitDayContext {
  /** El día ya se juzga: la ruta se finalizó o la fecha ya pasó. */
  closed: boolean;
  /** El vendedor mandó GPS útil ese día. */
  has_gps: boolean;
  radius_m?: number;
}

const iso = (v: string | Date | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

const REASONS: readonly VisitNoSaleReason[] = ['cerrado', 'no_atendio', 'con_inventario', 'sin_recursos', 'no_interesado', 'otro'];

export function classifyVisit(f: VisitCustomerFacts, ctx: VisitDayContext): VisitMonitorRow {
  const radius = ctx.radius_m ?? VISIT_RADIUS_M;
  const v = f.visit;
  let status: VisitMonitorStatus;
  if (f.ordered || (v && (v.had_order || v.had_ticket))) status = 'con_pedido';
  else if (v && v.ended_at) status = 'sin_pedido';
  else if (v) status = 'abierta';
  else if (!ctx.closed) status = 'pendiente';
  else if (!f.has_location) status = 'sin_ubicacion';
  else if (!ctx.has_gps) status = 'sin_gps';
  // `nearest_m` null con GPS = ningún punto cerca (la búsqueda se acota a ~2 km): no pasó.
  else if (f.nearest_m != null && f.nearest_m <= radius) status = 'se_fue_sin_abrir';
  else status = 'no_paso';

  const reason = status === 'sin_pedido' && v?.no_sale_reason && (REASONS as readonly string[]).includes(v.no_sale_reason)
    ? (v.no_sale_reason as VisitNoSaleReason)
    : null;
  const distance = v?.distance_m == null ? null : Math.round(Number(v.distance_m));
  return {
    customer_id: f.customer_id,
    code: f.code,
    name: f.name,
    on_route: f.on_route,
    has_location: f.has_location,
    status,
    no_sale_reason: reason,
    notes: v?.notes?.trim() || null,
    visited_at: iso(v?.visited_at),
    ended_at: iso(v?.ended_at),
    distance_m: distance,
    far: distance != null && distance > radius,
    nearest_m: f.nearest_m == null ? null : Math.round(Number(f.nearest_m)),
  };
}

export function emptyCounts(): VisitMonitorCounts {
  return {
    clientes: 0, visitados: 0, con_pedido: 0, sin_pedido: 0, abiertas: 0, faltas: 0,
    se_fue_sin_abrir: 0, no_paso: 0, sin_ubicacion: 0, sin_gps: 0, pendientes: 0, lejos: 0,
  };
}

/** Suma `rows` en `into` (o en unos conteos nuevos). */
export function countVisits(rows: readonly VisitMonitorRow[], into: VisitMonitorCounts = emptyCounts()): VisitMonitorCounts {
  for (const r of rows) {
    into.clientes++;
    switch (r.status) {
      case 'con_pedido': into.con_pedido++; into.visitados++; break;
      case 'sin_pedido': into.sin_pedido++; into.visitados++; break;
      case 'abierta': into.abiertas++; into.visitados++; break;
      case 'se_fue_sin_abrir': into.se_fue_sin_abrir++; into.faltas++; break;
      case 'no_paso': into.no_paso++; into.faltas++; break;
      case 'sin_ubicacion': into.sin_ubicacion++; break;
      case 'sin_gps': into.sin_gps++; break;
      case 'pendiente': into.pendientes++; break;
    }
    if (r.far) into.lejos++;
  }
  return into;
}

/** Suma conteos ya hechos (para el total de todos los vendedores). */
export function addCounts(a: VisitMonitorCounts, b: VisitMonitorCounts): VisitMonitorCounts {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof VisitMonitorCounts)[]) out[k] += b[k];
  return out;
}

/** Distancia en metros (haversine). */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** `YYYY-MM-DD` válido o `null`. */
export function parseYmd(s: unknown): string | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}
