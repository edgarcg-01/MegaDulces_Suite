import { Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';

const DEFAULT_TENANT_ID =
  process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// Parámetros de segmentación (mismos que map-matching.service del repo).
const STOP_RADIUS_M = 40; // dentro de este radio = misma parada
const STOP_MIN_MINUTES = 5; // duración mínima para contar como parada
const GEOFENCE_M = 90; // radio para matchear parada ↔ cliente
const OFFLINE_GAP_MIN = 30; // hueco entre fixes que cuenta como offline

export interface DayBuildResult {
  vehicle_id: string;
  day: string;
  fixes: number;
  stops: number;
  customer_stops: number;
  km_driven: number;
}

/** Haversine en metros (patrón vivo del repo, no PostGIS). */
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// MX no tiene DST desde 2022 → offset fijo -06:00.
function dayBoundsIso(day: string): { start: string; end: string } {
  return { start: `${day}T00:00:00-06:00`, end: `${day}T23:59:59.999-06:00` };
}

/**
 * Separación estricta ruta ↔ logística sobre queries por vehicle_id.
 * 'route' = vehículo con algún tracker con route_number; 'logistics' = sin él.
 * `vehicleCol` es un identificador interno (no input de usuario) → seguro en raw.
 */
export function applyFleetFilter(
  qb: Knex.QueryBuilder,
  trx: Knex,
  fleet: 'route' | 'logistics' | undefined,
  vehicleCol: string,
): void {
  if (fleet !== 'route' && fleet !== 'logistics') return;
  const sub = function (this: Knex.QueryBuilder) {
    this.select(trx.raw('1'))
      .from('logistics.trackers as tr')
      .whereRaw(`tr.vehicle_id = ${vehicleCol}`)
      .whereNotNull('tr.route_number');
  };
  if (fleet === 'route') qb.whereExists(sub);
  else qb.whereNotExists(sub);
}

@Injectable()
export class TripBuilderService {
  private readonly logger = new Logger(TripBuilderService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Reconstruye paradas + resumen de todos los vehículos con actividad en `day`. */
  async buildForDate(day: string, tenantId: string = DEFAULT_TENANT_ID): Promise<DayBuildResult[]> {
    const { start, end } = dayBoundsIso(day);
    return this.tk.run(tenantId, async (trx) => {
      // El vehículo se resuelve por el TRACKER (positions.vehicle_id quedó NULL en
      // el histórico: se insertó antes de vincular el tracker). tracker_id siempre
      // está → join a trackers para obtener el vehicle_id vigente.
      const vehicles: Array<{ vehicle_id: string }> = await trx('logistics.vehicle_positions as vp')
        .join('logistics.trackers as t', 't.id', 'vp.tracker_id')
        .whereRaw('vp.tenant_id = public.current_tenant_id()')
        .whereNotNull('t.vehicle_id')
        .whereBetween('vp.captured_at', [start, end])
        .distinct('t.vehicle_id as vehicle_id');
      const customers = await this.loadCustomers(trx);
      const stores = await this.loadStores(trx);
      const out: DayBuildResult[] = [];
      for (const v of vehicles) {
        out.push(await this.buildOne(trx, v.vehicle_id, day, start, end, customers, stores));
      }
      this.logger.log(`buildForDate ${day}: ${out.length} vehículos, ${out.reduce((a, r) => a + r.stops, 0)} paradas`);
      return out;
    });
  }

  /** Reconstruye un vehículo/día puntual (endpoint manual). */
  async buildForVehicleDay(vehicleId: string, day: string, tenantId: string = DEFAULT_TENANT_ID): Promise<DayBuildResult> {
    const { start, end } = dayBoundsIso(day);
    return this.tk.run(tenantId, async (trx) => {
      const customers = await this.loadCustomers(trx);
      const stores = await this.loadStores(trx);
      return this.buildOne(trx, vehicleId, day, start, end, customers, stores);
    });
  }

  private async loadCustomers(trx: Knex.Transaction): Promise<Array<{ id: string; lat: number; lng: number }>> {
    const rows = await trx('commercial.customers')
      .whereNotNull('latitude')
      .whereNull('deleted_at')
      .select('id', 'latitude', 'longitude');
    return rows
      .map((r: any) => ({ id: r.id, lat: Number(r.latitude), lng: Number(r.longitude) }))
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  }

  /** Tiendas de trade con coords (para matchear paradas del camión ↔ PdV de auditoría). */
  private async loadStores(trx: Knex.Transaction): Promise<Array<{ id: string; lat: number; lng: number }>> {
    const rows = await trx('public.stores')
      .whereNotNull('latitud')
      .whereNull('deleted_at')
      .select('id', 'latitud', 'longitud');
    return rows
      .map((r: any) => ({ id: r.id, lat: Number(r.latitud), lng: Number(r.longitud) }))
      .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  }

  private async buildOne(
    trx: Knex.Transaction,
    vehicleId: string,
    day: string,
    start: string,
    end: string,
    customers: Array<{ id: string; lat: number; lng: number }>,
    stores: Array<{ id: string; lat: number; lng: number }>,
  ): Promise<DayBuildResult> {
    // Posiciones del vehículo resueltas por el tracker (positions.vehicle_id puede
    // estar NULL en el histórico). Incluye todos los trackers del vehículo.
    const rows = await trx('logistics.vehicle_positions as vp')
      .join('logistics.trackers as t', 't.id', 'vp.tracker_id')
      .whereRaw('vp.tenant_id = public.current_tenant_id()')
      .where('t.vehicle_id', vehicleId)
      .whereBetween('vp.captured_at', [start, end])
      .orderBy('vp.captured_at', 'asc')
      .select('vp.lat', 'vp.lng', 'vp.captured_at', 'vp.speed_kmh');

    const fixes = rows
      .map((r: any) => ({ lat: Number(r.lat), lng: Number(r.lng), t: new Date(r.captured_at).getTime(), speed: r.speed_kmh }))
      .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng));

    // ── segmentar paradas ──
    const stops: Array<{ arrived: number; left: number; lat: number; lng: number; minutes: number }> = [];
    let km = 0;
    let offlineMin = 0;
    let maxSpeed = 0;
    let i = 0;
    while (i < fixes.length) {
      const anchor = fixes[i];
      let j = i;
      // extender mientras los fixes queden dentro del radio del ancla
      while (j + 1 < fixes.length && haversineM(anchor.lat, anchor.lng, fixes[j + 1].lat, fixes[j + 1].lng) <= STOP_RADIUS_M) {
        j++;
      }
      const runMin = (fixes[j].t - anchor.t) / 60000;
      if (j > i && runMin >= STOP_MIN_MINUTES) {
        // centroide del cluster
        const seg = fixes.slice(i, j + 1);
        const clat = seg.reduce((a, f) => a + f.lat, 0) / seg.length;
        const clng = seg.reduce((a, f) => a + f.lng, 0) / seg.length;
        stops.push({ arrived: anchor.t, left: fixes[j].t, lat: clat, lng: clng, minutes: Math.round(runMin) });
        i = j + 1;
      } else {
        i++;
      }
    }

    // ── km + offline + velocidad ──
    for (let k = 1; k < fixes.length; k++) {
      km += haversineM(fixes[k - 1].lat, fixes[k - 1].lng, fixes[k].lat, fixes[k].lng);
      const gapMin = (fixes[k].t - fixes[k - 1].t) / 60000;
      if (gapMin > OFFLINE_GAP_MIN) offlineMin += gapMin;
    }
    for (const f of fixes) if (Number.isFinite(f.speed) && f.speed > maxSpeed) maxSpeed = f.speed;
    const kmDriven = Math.round((km / 1000) * 100) / 100;

    const spanMin = fixes.length >= 2 ? (fixes[fixes.length - 1].t - fixes[0].t) / 60000 : 0;
    const stoppedMin = stops.reduce((a, s) => a + s.minutes, 0);
    const movingMin = Math.max(0, Math.round(spanMin - stoppedMin - offlineMin));

    // ── matchear paradas a clientes (comercial) + tiendas (trade) ──
    const nearest = (s: { lat: number; lng: number }, pts: Array<{ id: string; lat: number; lng: number }>) => {
      let best: { id: string; d: number } | null = null;
      for (const p of pts) {
        const d = haversineM(s.lat, s.lng, p.lat, p.lng);
        if (d <= GEOFENCE_M && (!best || d < best.d)) best = { id: p.id, d };
      }
      return best;
    };
    const stopRows = stops.map((s) => {
      const bc = nearest(s, customers);
      const bs = nearest(s, stores);
      return {
        ...s,
        matched_customer_id: bc?.id ?? null,
        matched_store_id: bs?.id ?? null,
        match_distance_m: bc ? Math.round(bc.d) : bs ? Math.round(bs.d) : null,
        is_customer: !!bc,
      };
    });
    const customerStops = stopRows.filter((s) => s.is_customer).length;

    // ── persistir (delete-then-insert del día para reflejar re-segmentación) ──
    await trx('logistics.vehicle_stops')
      .where({ vehicle_id: vehicleId })
      .whereBetween('arrived_at', [start, end])
      .del();
    if (stopRows.length) {
      await trx('logistics.vehicle_stops').insert(
        stopRows.map((s) => ({
          tenant_id: trx.raw('public.current_tenant_id()'),
          vehicle_id: vehicleId,
          arrived_at: new Date(s.arrived).toISOString(),
          left_at: new Date(s.left).toISOString(),
          minutes: s.minutes,
          lat: s.lat,
          lng: s.lng,
          matched_customer_id: s.matched_customer_id,
          matched_store_id: s.matched_store_id,
          match_distance_m: s.match_distance_m,
          is_customer: s.is_customer,
        })),
      );
    }

    await trx('logistics.vehicle_day_summary')
      .insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        vehicle_id: vehicleId,
        day,
        km_driven: kmDriven,
        moving_min: movingMin,
        stopped_min: stoppedMin,
        offline_min: Math.round(offlineMin),
        stops_count: stopRows.length,
        customer_stops: customerStops,
        first_move_at: fixes.length ? new Date(fixes[0].t).toISOString() : null,
        last_stop_at: stops.length ? new Date(stops[stops.length - 1].left).toISOString() : null,
        max_speed_kmh: maxSpeed || null,
        updated_at: trx.fn.now(),
      })
      .onConflict(['tenant_id', 'vehicle_id', 'day'])
      .merge();

    return { vehicle_id: vehicleId, day, fixes: fixes.length, stops: stopRows.length, customer_stops: customerStops, km_driven: kmDriven };
  }

  /**
   * Resumen diario de vehículos con actividad en `day`.
   * `fleet`: 'route' = solo unidades de ruta; 'logistics' = solo flota logística
   * (separación estricta por logistics.trackers.route_number).
   */
  async listDaySummary(day: string, fleet?: 'route' | 'logistics') {
    return this.tk.run(async (trx) => {
      return trx('logistics.vehicle_day_summary as s')
        .leftJoin('logistics.vehicles as v', function () {
          this.on('v.tenant_id', 's.tenant_id').andOn('v.id', 's.vehicle_id');
        })
        .where('s.day', day)
        .modify((qb) => applyFleetFilter(qb, trx, fleet, 's.vehicle_id'))
        .select('s.*', 'v.plate as vehicle_plate')
        .orderBy('s.km_driven', 'desc');
    });
  }

  /**
   * Paradas de un vehículo en un día, con cliente + tienda matcheados y un flag
   * `captured`: ¿hubo una captura de auditoría en esa parada? Se cruza por
   * cercanía GPS (≤150 m del punto de la parada) dentro de la ventana temporal
   * (±10 min) — robusto ante daily_captures.store_id poco poblado.
   */
  async listStops(vehicleId: string, day: string) {
    const { start, end } = dayBoundsIso(day);
    return this.tk.run(async (trx) => {
      return trx('logistics.vehicle_stops as st')
        .leftJoin('commercial.customers as c', function () {
          this.on('c.tenant_id', 'st.tenant_id').andOn('c.id', 'st.matched_customer_id');
        })
        .leftJoin('public.stores as s', 's.id', 'st.matched_store_id')
        .where('st.vehicle_id', vehicleId)
        .whereBetween('st.arrived_at', [start, end])
        .select(
          'st.*',
          'c.name as customer_name',
          'c.code as customer_code',
          's.nombre as store_name',
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
        )
        .orderBy('st.arrived_at', 'asc');
    });
  }
}
