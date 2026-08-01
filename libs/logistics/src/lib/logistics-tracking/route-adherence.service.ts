import { Injectable, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import { applyFleetFilter, TripBuilderService } from './trip-builder.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdherenceResult {
  vehicle_id: string;
  day: string;
  route_ids: string[]; // nombre(s) de la ruta trade servida
  evaluable: boolean; // false si la unidad no tocó ninguna tienda geolocalizada
  planned_count: number;
  planned_with_coords: number;
  visited_count: number;
  captured_count: number; // de las visitadas, cuántas tuvieron captura de auditoría
  skipped_count: number;
  off_route_count: number;
  coverage_pct: number | null; // visitados / plan-con-coords
  planned: Array<{ customer_id: string; code: string | null; name: string | null; visit_sequence: number | null; has_coords: boolean; lat: number | null; lng: number | null; visited: boolean; captured: boolean }>;
  skipped: Array<{ customer_id: string; code: string | null; name: string | null }>;
  off_route_stops: Array<{ arrived_at: string; minutes: number; lat: number; lng: number }>;
}

/** Detalle de auditoría de UN vehículo/día: traza GPS + paradas + tickets ubicados. */
export interface VehicleAuditDetail {
  vehicle_id: string;
  day: string;
  route_numbers: number[];
  path: Array<{ lat: number; lng: number; captured_at: string; speed_kmh: number | null }>;
  stops: Array<{ seq: number; arrived_at: string; left_at: string; minutes: number; lat: number; lng: number; matched_store_id: string | null; store_name: string | null; in_plan: boolean; kind: 'plan_store' | 'off_route' | 'unmatched' }>;
  tickets: Array<{
    id: string;
    ticket_type: string;
    ticket_time: string | null;
    ticket_date: string;
    total: number | null;
    corte_number: string | null;
    reference: string | null;
    liters: number | null;
    photo_url: string | null;
    photo_preview_url: string | null;
    created_at: string;
    route_code: string;
    at_lat: number | null;
    at_lng: number | null;
    gps_gap_min: number | null; // min entre la hora del ticket y el fix GPS más cercano
    near_store_name: string | null; // tienda más cercana a la posición del ticket
    located: boolean;
  }>;
}

/** Número de ruta a partir de un código libre ("R-12", "RUTA 12", "12") → 12. */
function routeDigits(s: string | null | undefined): number | null {
  const m = (s || '').replace(/\D/g, '');
  return m ? parseInt(m, 10) : null;
}

/** Downsample uniforme de la traza a ≤max puntos (conserva primero y último). */
function downsamplePath<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[Math.floor(i)]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

/** Haversine en metros (sin PostGIS). */
function haversineMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * LTV.1 — Cumplimiento de ruta: cruza el plan (clientes de la ruta que la unidad
 * sirvió ese día) contra lo real (paradas matcheadas a cliente en LTV.0).
 *
 * Solo los clientes del plan CON coordenadas son evaluables (sin coords no se
 * puede saber si la unidad estuvo ahí) → se reportan aparte, no cuentan como
 * "saltados".
 */
@Injectable()
export class RouteAdherenceService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly trips: TripBuilderService,
  ) {}

  /**
   * On-demand: si el día pedido no tiene viajes reconstruidos pero SÍ hay
   * posiciones GPS, los reconstruye ahora. Así la pantalla no depende de que el
   * cron nocturno haya corrido (en prod había 23k posiciones y 0 paradas).
   */
  private async ensureBuilt(day: string, start: string, end: string): Promise<void> {
    const built = await this.tk.run((trx) =>
      trx('logistics.vehicle_day_summary').where('day', day).first('id'),
    );
    if (built) return;
    const hasPos = await this.tk.run((trx) =>
      trx('logistics.vehicle_positions')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .whereBetween('captured_at', [start, end])
        .first('tracker_id'),
    );
    if (hasPos) await this.trips.buildForDate(day);
  }

  async forVehicleDay(vehicleId: string, day: string): Promise<AdherenceResult> {
    if (!UUID_REGEX.test(vehicleId)) throw new BadRequestException('vehicle_id inválido');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;
    return this.tk.run((trx) => this.computeForVehicle(trx, vehicleId, day, start, end));
  }

  /**
   * Detalle de auditoría de un vehículo/día: la traza GPS (recorrido real), las
   * paradas reconstruidas (matcheadas a tienda) y los tickets del día del vendedor
   * (venta/carga/combustible), cada uno UBICADO cruzando su hora impresa
   * (ticket_time) contra el fix GPS más cercano — "dónde estaba cuando lo generó".
   * Los tickets se ligan al vehículo por route_number del tracker ↔ route_code.
   */
  async vehicleAuditDetail(vehicleId: string, day: string): Promise<VehicleAuditDetail> {
    if (!UUID_REGEX.test(vehicleId)) throw new BadRequestException('vehicle_id inválido');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;
    await this.ensureBuilt(day, start, end);
    return this.tk.run((trx) => this.buildGeoBundle(trx, vehicleId, day, start, end));
  }

  /** Núcleo geo (traza + paradas + tickets) de un vehículo/día, dentro de un trx dado. */
  private async buildGeoBundle(trx: Knex.Transaction, vehicleId: string, day: string, start: string, end: string): Promise<VehicleAuditDetail> {
    {
      // ── traza GPS (recorrido real), resuelta por el tracker ──
      const posRows = await trx('logistics.vehicle_positions as vp')
        .join('logistics.trackers as t', 't.id', 'vp.tracker_id')
        .whereRaw('vp.tenant_id = public.current_tenant_id()')
        .where('t.vehicle_id', vehicleId)
        .whereBetween('vp.captured_at', [start, end])
        .orderBy('vp.captured_at', 'asc')
        .select('vp.lat', 'vp.lng', 'vp.captured_at', 'vp.speed_kmh');
      const path = (posRows as any[])
        .map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), captured_at: new Date(r.captured_at).toISOString(), t: new Date(r.captured_at).getTime(), speed_kmh: r.speed_kmh != null ? Number(r.speed_kmh) : null }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

      // ── paradas reconstruidas del día (con tienda matcheada + ruta) ──
      const stopRows = await trx('logistics.vehicle_stops as st')
        .leftJoin('public.stores as s', 's.id', 'st.matched_store_id')
        .where('st.vehicle_id', vehicleId)
        .whereBetween('st.arrived_at', [start, end])
        .orderBy('st.arrived_at', 'asc')
        .select('st.arrived_at', 'st.left_at', 'st.minutes', 'st.lat', 'st.lng', 'st.matched_store_id', 's.nombre as store_name', 's.ruta_id');
      // Ruta dominante = la ruta_id más frecuente entre las tiendas que tocó, para
      // saber si una parada cae DENTRO de su ruta o fue fuera de ruta.
      const routeFreq = new Map<string, number>();
      for (const s of stopRows as any[]) if (s.ruta_id) routeFreq.set(s.ruta_id, (routeFreq.get(s.ruta_id) || 0) + 1);
      let dominantRoute: string | null = null, bestFreq = 0;
      for (const [rid, c] of routeFreq) if (c > bestFreq) { bestFreq = c; dominantRoute = rid; }
      const stops = (stopRows as any[]).map((s, i) => {
        const inPlan = !!s.matched_store_id && !!dominantRoute && s.ruta_id === dominantRoute;
        const kind: 'plan_store' | 'off_route' | 'unmatched' = !s.matched_store_id ? 'unmatched' : inPlan ? 'plan_store' : 'off_route';
        return {
          seq: i + 1,
          arrived_at: new Date(s.arrived_at).toISOString(),
          left_at: new Date(s.left_at).toISOString(),
          minutes: Number(s.minutes),
          lat: Number(s.lat),
          lng: Number(s.lng),
          matched_store_id: s.matched_store_id ?? null,
          store_name: s.store_name ?? null,
          in_plan: inPlan,
          kind,
        };
      });

      // ── número(s) de ruta del vehículo (para ligar sus tickets) ──
      const trkRows = await trx('logistics.trackers')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .where('vehicle_id', vehicleId)
        .whereNotNull('route_number')
        .whereNull('deleted_at')
        .distinct('route_number');
      const routeNumbers = Array.from(new Set((trkRows as any[]).map((r) => Number(r.route_number)).filter((n) => Number.isFinite(n))));

      // ── tickets del día de esa(s) ruta(s), ubicados por hora ──
      let tickets: VehicleAuditDetail['tickets'] = [];
      if (routeNumbers.length) {
        const rawTickets = await trx('commercial.route_tickets')
          .whereRaw('tenant_id = public.current_tenant_id()')
          .whereNull('deleted_at')
          .where('ticket_date', day)
          .select('id', 'ticket_type', 'ticket_time', 'ticket_date', 'total', 'corte_number', 'reference', 'liters', 'photo_url', 'photo_preview_url', 'created_at', 'route_code');

        const nearestByTime = (tsMs: number) => {
          let best: { lat: number; lng: number; gap: number } | null = null;
          for (const p of path) {
            const gap = Math.abs(p.t - tsMs);
            if (!best || gap < best.gap) best = { lat: p.lat, lng: p.lng, gap };
          }
          return best;
        };
        const nearestStore = (lat: number, lng: number): string | null => {
          let best: { name: string | null; d: number } | null = null;
          for (const s of stops) {
            const d = haversineMeters(lat, lng, s.lat, s.lng);
            if (!best || d < best.d) best = { name: s.store_name, d };
          }
          return best && best.d <= 200 ? best.name : null;
        };

        tickets = (rawTickets as any[])
          .filter((t) => routeNumbers.includes(routeDigits(t.route_code) ?? -1))
          .map((t) => {
            const dayStr = (t.ticket_date instanceof Date ? t.ticket_date.toISOString().slice(0, 10) : String(t.ticket_date).slice(0, 10));
            let at_lat: number | null = null, at_lng: number | null = null, gap: number | null = null, near: string | null = null;
            if (t.ticket_time) {
              const tsMs = new Date(`${dayStr}T${String(t.ticket_time)}-06:00`).getTime();
              const near2 = Number.isFinite(tsMs) ? nearestByTime(tsMs) : null;
              if (near2) { at_lat = near2.lat; at_lng = near2.lng; gap = Math.round(near2.gap / 60000); near = nearestStore(near2.lat, near2.lng); }
            }
            return {
              id: t.id,
              ticket_type: t.ticket_type,
              ticket_time: t.ticket_time != null ? String(t.ticket_time) : null,
              ticket_date: dayStr,
              total: t.total != null ? Number(t.total) : null,
              corte_number: t.corte_number ?? null,
              reference: t.reference ?? null,
              liters: t.liters != null ? Number(t.liters) : null,
              photo_url: t.photo_url ?? null,
              photo_preview_url: t.photo_preview_url ?? null,
              created_at: new Date(t.created_at).toISOString(),
              route_code: t.route_code,
              at_lat, at_lng, gps_gap_min: gap, near_store_name: near, located: at_lat != null,
            };
          })
          .sort((a, b) => (a.ticket_time || '').localeCompare(b.ticket_time || ''));
      }

      return {
        vehicle_id: vehicleId,
        day,
        route_numbers: routeNumbers,
        path: path.map(({ lat, lng, captured_at, speed_kmh }) => ({ lat, lng, captured_at, speed_kmh })),
        stops,
        tickets,
      };
    }
  }

  /**
   * Multi-ruta — detalle geográfico de TODA la flota de ruta en un día (mapa
   * principal). Por cada unidad con actividad: cumplimiento (plan visitado/saltado)
   * + traza (downsampleada) + paradas + tickets. Filtrable por route_numbers.
   * El recorrido se downsamplea a `maxPathPts` puntos/unidad para acotar el payload.
   */
  async fleetAuditDetail(day: string, routeNumbers?: number[], maxPathPts = 400): Promise<Array<{
    vehicle_id: string;
    vehicle_plate: string | null;
    route_number: number | null;
    coverage_pct: number | null;
    visited_count: number;
    planned_with_coords: number;
    planned: AdherenceResult['planned'];
    path: VehicleAuditDetail['path'];
    stops: VehicleAuditDetail['stops'];
    tickets: VehicleAuditDetail['tickets'];
  }>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;
    await this.ensureBuilt(day, start, end);
    const filter = routeNumbers && routeNumbers.length ? new Set(routeNumbers) : null;

    return this.tk.run(async (trx) => {
      const withActivity: Array<{ vehicle_id: string }> = await trx('logistics.vehicle_day_summary as s')
        .where('s.day', day)
        .whereNotNull('s.vehicle_id')
        .modify((qb) => applyFleetFilter(qb, trx, 'route', 's.vehicle_id'))
        .distinct('s.vehicle_id as vehicle_id');
      const ids = Array.from(new Set(withActivity.map((r) => r.vehicle_id)));
      if (!ids.length) return [];

      const plateRows = await trx('logistics.vehicles').whereIn('id', ids).select('id', 'plate');
      const plateById = new Map(plateRows.map((v: any) => [v.id, v.plate ?? null]));
      const trkRows = await trx('logistics.trackers')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .whereIn('vehicle_id', ids)
        .whereNotNull('route_number')
        .whereNull('deleted_at')
        .select('vehicle_id', 'route_number');
      const routeByVehicle = new Map<string, number>();
      for (const r of trkRows as any[]) if (!routeByVehicle.has(r.vehicle_id)) routeByVehicle.set(r.vehicle_id, Number(r.route_number));

      const out = [];
      for (const id of ids) {
        const routeNum = routeByVehicle.get(id) ?? null;
        if (filter && !(routeNum != null && filter.has(routeNum))) continue;
        const adh = await this.computeForVehicle(trx, id, day, start, end);
        const geo = await this.buildGeoBundle(trx, id, day, start, end);
        out.push({
          vehicle_id: id,
          vehicle_plate: plateById.get(id) ?? null,
          route_number: routeNum,
          coverage_pct: adh.coverage_pct,
          visited_count: adh.visited_count,
          planned_with_coords: adh.planned_with_coords,
          planned: adh.planned,
          path: downsamplePath(geo.path, maxPathPts),
          stops: geo.stops,
          tickets: geo.tickets,
        });
      }
      return out.sort((a, b) => (a.route_number ?? 999) - (b.route_number ?? 999));
    });
  }

  /**
   * Fase 4 — Recorrido "por calles": pega la traza GPS del vehículo a la red de
   * calles (Mapbox Map Matching, chunks de ≤100 pts). On-demand (el toggle lo
   * pide). Sin MAPBOX_TOKEN o si el matching falla, cae al trazo crudo marcado
   * como baja confianza (≈ aprox). Devuelve coords [lng,lat] (orden GeoJSON).
   */
  async snapAuditRoute(vehicleId: string, day: string): Promise<{ coordinates: [number, number][]; low_confidence: boolean; point_count: number }> {
    if (!UUID_REGEX.test(vehicleId)) throw new BadRequestException('vehicle_id inválido');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;

    const rows = await this.tk.run((trx) =>
      trx('logistics.vehicle_positions as vp')
        .join('logistics.trackers as t', 't.id', 'vp.tracker_id')
        .whereRaw('vp.tenant_id = public.current_tenant_id()')
        .where('t.vehicle_id', vehicleId)
        .whereBetween('vp.captured_at', [start, end])
        .orderBy('vp.captured_at', 'asc')
        .select('vp.lat', 'vp.lng', 'vp.captured_at'),
    );
    let pts = (rows as any[])
      .map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), ts: new Date(r.captured_at).getTime() }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (pts.length < 2) return { coordinates: [], low_confidence: true, point_count: pts.length };

    // Downsample a ≤1000 puntos (uniforme, conserva extremos).
    const MAX_IN = 1000;
    if (pts.length > MAX_IN) {
      const step = pts.length / MAX_IN;
      const out: typeof pts = [];
      for (let i = 0; i < pts.length; i += step) out.push(pts[Math.floor(i)]);
      if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
      pts = out;
    }

    const token = process.env.MAPBOX_TOKEN || '';
    const rawCoords = pts.map((p) => [p.lng, p.lat] as [number, number]);
    if (!token) return { coordinates: rawCoords, low_confidence: true, point_count: pts.length };

    const CHUNK = 100;
    const coords: [number, number][] = [];
    let matchedAny = false;
    for (let i = 0; i < pts.length; i += CHUNK - 1) {
      const chunk = pts.slice(i, i + CHUNK);
      if (chunk.length < 2) break;
      const seg = await this.mapboxMatch(chunk, token);
      const source = seg ?? chunk.map((p) => [p.lng, p.lat] as [number, number]);
      if (seg) matchedAny = true;
      for (const c of source) {
        const last = coords[coords.length - 1];
        if (last && last[0] === c[0] && last[1] === c[1]) continue;
        coords.push(c);
      }
    }
    return { coordinates: coords.length >= 2 ? coords : rawCoords, low_confidence: !matchedAny, point_count: pts.length };
  }

  /** Un chunk (≤100 pts) contra Mapbox Map Matching. null si falla. */
  private async mapboxMatch(chunk: Array<{ lat: number; lng: number; ts: number }>, token: string): Promise<[number, number][] | null> {
    const coordStr = chunk.map((p) => `${p.lng},${p.lat}`).join(';');
    const radiuses = chunk.map(() => 20).join(';');
    const timestamps = chunk.map((p) => Math.floor(p.ts / 1000)).join(';');
    const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordStr}?geometries=geojson&overview=full&tidy=true&radiuses=${radiuses}&timestamps=${timestamps}&access_token=${token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const json: any = await res.json();
      const m = json?.matchings?.[0];
      if (json?.code !== 'Ok' || !m?.geometry?.coordinates?.length) return null;
      return m.geometry.coordinates as [number, number][];
    } catch {
      return null;
    }
  }

  /**
   * LTV.1 batch — cumplimiento de TODA la flota en un día. Une los vehículos que
   * tuvieron embarque con ruta ese día + los que tuvieron actividad GPS, y calcula
   * el cumplimiento de cada uno en una sola transacción. Ordena por peor
   * cumplimiento (evaluables primero). Es la fuente de "Auditoría de ruta".
   */
  async forFleetDay(day: string): Promise<Array<AdherenceResult & { vehicle_plate: string | null; route_number: number | null }>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;
    await this.ensureBuilt(day, start, end);

    return this.tk.run(async (trx) => {
      // Candidatos: vehículos con actividad GPS ese día (los que realmente
      // manejaron). El plan de cada uno sale de su tracker (route_number).
      const withActivity: Array<{ vehicle_id: string }> = await trx('logistics.vehicle_day_summary as s')
        .where('s.day', day)
        .whereNotNull('s.vehicle_id')
        .modify((qb) => applyFleetFilter(qb, trx, 'route', 's.vehicle_id'))
        .distinct('s.vehicle_id as vehicle_id');
      const ids = Array.from(new Set(withActivity.map((r) => r.vehicle_id)));
      if (!ids.length) return [];

      const plateRows = await trx('logistics.vehicles').whereIn('id', ids).select('id', 'plate');
      const plateById = new Map(plateRows.map((v: any) => [v.id, v.plate ?? null]));
      const trkRows = await trx('logistics.trackers')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .whereIn('vehicle_id', ids)
        .whereNotNull('route_number')
        .whereNull('deleted_at')
        .select('vehicle_id', 'route_number');
      const routeByVehicle = new Map<string, number>();
      for (const r of trkRows as any[]) if (!routeByVehicle.has(r.vehicle_id)) routeByVehicle.set(r.vehicle_id, Number(r.route_number));

      const out: Array<AdherenceResult & { vehicle_plate: string | null; route_number: number | null }> = [];
      for (const id of ids) {
        const r = await this.computeForVehicle(trx, id, day, start, end);
        out.push({ ...r, vehicle_plate: plateById.get(id) ?? null, route_number: routeByVehicle.get(id) ?? null });
      }
      // Evaluables primero, dentro de esos por peor cobertura; luego no-evaluables.
      return out.sort((a, b) => {
        if (a.evaluable !== b.evaluable) return a.evaluable ? -1 : 1;
        return (a.coverage_pct ?? 101) - (b.coverage_pct ?? 101);
      });
    });
  }

  /**
   * Diagnóstico del vacío: revisa la cadena de eslabones y devuelve cuál falta,
   * para que "sin rutas para auditar" sea accionable (no ambiguo).
   */
  async diagnose(day: string): Promise<{
    positions_day: number;
    last_position_at: string | null;
    route_trucks: number;
    trucks_with_activity: number;
    store_stops_built: number;
    stores_with_route: number;
    reason: string;
  }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;
    return this.tk.run(async (trx) => {
      const n = async (qb: any) => Number((await qb.count({ c: '*' }).first())?.c ?? 0);
      const positions_day = await n(
        trx('logistics.vehicle_positions').whereRaw('tenant_id = public.current_tenant_id()').whereBetween('captured_at', [start, end]),
      );
      const lastRow = await trx('logistics.vehicle_positions')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .max({ m: 'captured_at' })
        .first();
      const route_trucks = await n(trx('logistics.trackers').whereNull('deleted_at').whereNotNull('route_number'));
      const trucks_with_activity = await n(trx('logistics.vehicle_day_summary as s').where('s.day', day).modify((qb: any) => applyFleetFilter(qb, trx, 'route', 's.vehicle_id')));
      const store_stops_built = await n(trx('logistics.vehicle_stops').whereBetween('arrived_at', [start, end]).whereNotNull('matched_store_id'));
      const stores_with_route = await n(trx('public.stores').whereNull('deleted_at').whereNotNull('ruta_id').whereNotNull('latitud'));

      let reason = 'OK';
      if (positions_day === 0) reason = 'Sin posiciones GPS ese día (¿el poller está corriendo? faltan credenciales o redeploy).';
      else if (route_trucks === 0) reason = 'Ningún tracker tiene ruta asignada (route_number). Sincronizá rutas/operadores o asigná a mano.';
      else if (trucks_with_activity === 0) reason = 'Hay posiciones pero ningún camión de ruta con actividad reconstruida ese día.';
      else if (store_stops_built === 0) reason = 'Se reconstruyeron viajes pero ninguna parada matcheó una tienda (¿tiendas sin coordenadas o lejos de la ruta?).';
      else if (stores_with_route === 0) reason = 'Las tiendas no tienen ruta_id → no hay plan contra el cual medir.';

      return {
        positions_day,
        last_position_at: lastRow?.m ? new Date(lastRow.m).toISOString() : null,
        route_trucks,
        trucks_with_activity,
        store_stops_built,
        stores_with_route,
        reason,
      };
    });
  }

  /** Núcleo reutilizable: cumplimiento de un vehículo en un día (dentro de un trx dado). */
  private async computeForVehicle(
    trx: Knex.Transaction,
    vehicleId: string,
    day: string,
    start: string,
    end: string,
  ): Promise<AdherenceResult> {
    {
      // Cumplimiento en el dominio AUDITORÍA: plan = tiendas de trade (stores) de
      // la ruta que la unidad sirvió; real = tiendas donde el camión se detuvo;
      // captura = si además hubo una captura de auditoría ahí. La ruta se infiere
      // de la ruta dominante (stores.ruta_id) entre las tiendas que tocó — no se
      // depende de puentes de modelos de ruta.
      const stopRows = await trx('logistics.vehicle_stops as st')
        .leftJoin('public.stores as s', 's.id', 'st.matched_store_id')
        .where('st.vehicle_id', vehicleId)
        .whereBetween('st.arrived_at', [start, end])
        .whereNotNull('st.matched_store_id')
        .select(
          'st.matched_store_id as store_id',
          's.ruta_id',
          'st.arrived_at',
          'st.minutes',
          'st.lat',
          'st.lng',
          trx.raw(`EXISTS (
            SELECT 1 FROM public.daily_captures dc
            WHERE dc.hora_inicio BETWEEN st.arrived_at - interval '10 minutes' AND st.left_at + interval '10 minutes'
              AND dc.latitud IS NOT NULL AND dc.longitud IS NOT NULL
              AND 2 * 6371000 * asin(sqrt(
                power(sin(radians(dc.latitud::float8 - st.lat::float8) / 2), 2) +
                cos(radians(st.lat::float8)) * cos(radians(dc.latitud::float8)) *
                power(sin(radians(dc.longitud::float8 - st.lng::float8) / 2), 2)
              )) <= 150
          ) as captured`),
        );

      // Ruta dominante = la ruta_id más frecuente entre las tiendas visitadas.
      const routeCount = new Map<string, number>();
      for (const s of stopRows as any[]) if (s.ruta_id) routeCount.set(s.ruta_id, (routeCount.get(s.ruta_id) || 0) + 1);
      let dominantRoute: string | null = null;
      let bestCount = 0;
      for (const [rid, cnt] of routeCount) if (cnt > bestCount) { bestCount = cnt; dominantRoute = rid; }

      const visitedStore = new Set((stopRows as any[]).map((s) => s.store_id));
      const capturedStore = new Set((stopRows as any[]).filter((s) => s.captured).map((s) => s.store_id));

      // Plan = tiendas activas de la ruta dominante.
      const planned = dominantRoute
        ? await trx('public.stores')
            .where('ruta_id', dominantRoute)
            .whereNull('deleted_at')
            .select('id as store_id', 'nombre as name', 'latitud', 'longitud')
            .orderBy('nombre', 'asc')
        : [];
      const routeName = dominantRoute
        ? (await trx('catalogs').where('id', dominantRoute).first('value'))?.value ?? null
        : null;

      const plannedRows = (planned as any[]).map((p) => ({
        customer_id: p.store_id,
        code: null,
        name: p.name ?? null,
        visit_sequence: null,
        has_coords: p.latitud != null,
        lat: p.latitud != null ? Number(p.latitud) : null,
        lng: p.longitud != null ? Number(p.longitud) : null,
        visited: visitedStore.has(p.store_id),
        captured: capturedStore.has(p.store_id),
      }));
      const plannedWithCoords = plannedRows.filter((p) => p.has_coords);
      const skipped = plannedWithCoords.filter((p) => !p.visited).map((p) => ({ customer_id: p.customer_id, code: p.code, name: p.name }));
      const visitedCount = plannedWithCoords.filter((p) => p.visited).length;
      const capturedCount = plannedWithCoords.filter((p) => p.captured).length;
      const plannedIds = new Set(plannedRows.map((p) => p.customer_id));

      // Paradas fuera de ruta: tienda visitada que no pertenece a la ruta dominante.
      const offRoute = (stopRows as any[])
        .filter((s) => !plannedIds.has(s.store_id))
        .map((s) => ({ arrived_at: s.arrived_at, minutes: s.minutes, lat: Number(s.lat), lng: Number(s.lng) }));

      const evaluable = plannedWithCoords.length > 0;
      return {
        vehicle_id: vehicleId,
        day,
        route_ids: routeName ? [routeName] : [],
        evaluable,
        planned_count: plannedRows.length,
        planned_with_coords: plannedWithCoords.length,
        visited_count: visitedCount,
        captured_count: capturedCount,
        skipped_count: skipped.length,
        off_route_count: offRoute.length,
        coverage_pct: evaluable ? Math.round((visitedCount / plannedWithCoords.length) * 100) : null,
        planned: plannedRows,
        skipped,
        off_route_stops: offRoute,
      };
    }
  }
}
