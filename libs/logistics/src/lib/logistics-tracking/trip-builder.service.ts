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
      const vehicles: Array<{ vehicle_id: string }> = await trx('logistics.vehicle_positions')
        .whereRaw('tenant_id = public.current_tenant_id()')
        .whereNotNull('vehicle_id')
        .whereBetween('captured_at', [start, end])
        .distinct('vehicle_id');
      const customers = await this.loadCustomers(trx);
      const out: DayBuildResult[] = [];
      for (const v of vehicles) {
        out.push(await this.buildOne(trx, v.vehicle_id, day, start, end, customers));
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
      return this.buildOne(trx, vehicleId, day, start, end, customers);
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

  private async buildOne(
    trx: Knex.Transaction,
    vehicleId: string,
    day: string,
    start: string,
    end: string,
    customers: Array<{ id: string; lat: number; lng: number }>,
  ): Promise<DayBuildResult> {
    const rows = await trx('logistics.vehicle_positions')
      .whereRaw('tenant_id = public.current_tenant_id()')
      .where({ vehicle_id: vehicleId })
      .whereBetween('captured_at', [start, end])
      .orderBy('captured_at', 'asc')
      .select('lat', 'lng', 'captured_at', 'speed_kmh');

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

    // ── matchear paradas a clientes ──
    const stopRows = stops.map((s) => {
      let best: { id: string; d: number } | null = null;
      for (const c of customers) {
        const d = haversineM(s.lat, s.lng, c.lat, c.lng);
        if (d <= GEOFENCE_M && (!best || d < best.d)) best = { id: c.id, d };
      }
      return { ...s, matched_customer_id: best?.id ?? null, match_distance_m: best ? Math.round(best.d) : null, is_customer: !!best };
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

  /** Paradas de un vehículo en un día, con nombre del cliente matcheado. */
  async listStops(vehicleId: string, day: string) {
    const { start, end } = dayBoundsIso(day);
    return this.tk.run(async (trx) => {
      return trx('logistics.vehicle_stops as st')
        .leftJoin('commercial.customers as c', function () {
          this.on('c.tenant_id', 'st.tenant_id').andOn('c.id', 'st.matched_customer_id');
        })
        .where('st.vehicle_id', vehicleId)
        .whereBetween('st.arrived_at', [start, end])
        .select('st.*', 'c.name as customer_name', 'c.code as customer_code')
        .orderBy('st.arrived_at', 'asc');
    });
  }
}
