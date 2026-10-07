import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { applyFleetFilter } from './trip-builder.service';

// Parada improductiva: detenido ≥ este umbral SIN cliente matcheado (mismo criterio
// que IDLE_DEAD_THRESHOLD_MIN de reports.service para vendedores).
const DEAD_THRESHOLD_MIN = 20;
// Parada "fuera de tienda" para el mapa/alerta: detenido ≥ este umbral SIN cliente
// NI tienda matcheados (un lugar que no es punto de venta).
const OFF_STORE_MIN = 15;
// Idle (motor encendido detenido): tope de hueco entre fixes que se atribuye a
// ralentí — huecos mayores se consideran señal perdida (offline), no ralentí.
const IDLE_GAP_CAP_MIN = 15;
// Exceso de velocidad para la señal de alerta.
const SPEEDING_KMH = 90;

export interface ProductivityRow {
  vehicle_id: string;
  vehicle_plate: string | null;
  day: string;
  km_driven: number;
  moving_min: number;
  stopped_min: number;
  dead_min: number; // detenido improductivo (paradas largas sin cliente)
  offline_min: number;
  stops_count: number;
  customer_stops: number;
  dead_stops: number;
  km_per_customer_stop: number | null;
  // Fusión con auditoría (LTV.13): paradas en tienda de trade y si hubo captura.
  store_stops: number;
  captured_stops: number;
  uncaptured_stops: number;
}

/** Una unidad en el cockpit del Mapa en Vivo (LTV.19): productividad + combustible + idle. */
export interface FleetCockpitUnit {
  vehicle_id: string;
  vehicle_plate: string | null;
  route_number: number | null;
  km_driven: number;
  moving_min: number;
  stopped_min: number;
  idle_min: number; // motor encendido detenido (ralentí)
  offline_min: number;
  dead_min: number; // paradas largas sin cliente (productividad)
  dead_stops: number;
  off_store_stops: number; // paradas sin tienda NI cliente (mapa/alerta)
  customer_stops: number;
  store_stops: number;
  stops_count: number;
  first_move_at: string | null;
  last_stop_at: string | null;
  work_min: number | null; // jornada = último regreso − primera salida
  max_speed_kmh: number | null;
  speeding: boolean;
  liters: number;
  fuel_cost: number;
  km_per_liter: number | null;
  cost_per_km: number | null;
}

/** Parada del camión fuera de un PdV (ni tienda ni cliente), para capa de mapa + alerta. */
export interface FleetDeadStop {
  vehicle_id: string;
  vehicle_plate: string | null;
  route_number: number | null;
  lat: number;
  lng: number;
  arrived_at: string;
  left_at: string | null;
  minutes: number;
}

export interface FleetCockpitBundle {
  date: string;
  units: FleetCockpitUnit[];
  dead_stops: FleetDeadStop[];
  totals: {
    units: number;
    km: number;
    idle_min: number;
    dead_min: number;
    liters: number;
    fuel_cost: number;
    off_store_stops: number;
  };
}

/**
 * LTV.5 — Productividad y tiempos muertos de la flota. Deriva de LTV.0
 * (vehicle_day_summary + vehicle_stops): tiempo en tienda vs traslado, paradas
 * productivas (cliente) vs muertas (largas sin cliente), km por entrega.
 */
@Injectable()
export class FleetProductivityService {
  constructor(private readonly tk: TenantKnexService) {}

  async forFleetDay(day: string, fleet?: 'route' | 'logistics'): Promise<ProductivityRow[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;

    return this.tk.run(async (trx) => {
      const summaries = await trx('logistics.vehicle_day_summary as s')
        .leftJoin('logistics.vehicles as v', function () {
          this.on('v.tenant_id', 's.tenant_id').andOn('v.id', 's.vehicle_id');
        })
        .where('s.day', day)
        .modify((qb) => applyFleetFilter(qb, trx, fleet, 's.vehicle_id'))
        .select('s.vehicle_id', 'v.plate as vehicle_plate', 's.km_driven', 's.moving_min', 's.stopped_min', 's.offline_min', 's.stops_count', 's.customer_stops');

      // Paradas muertas: no cliente + duración ≥ umbral.
      const dead = await trx('logistics.vehicle_stops')
        .whereBetween('arrived_at', [start, end])
        .where('is_customer', false)
        .where('minutes', '>=', DEAD_THRESHOLD_MIN)
        .groupBy('vehicle_id')
        .select('vehicle_id')
        .sum({ dead_min: 'minutes' })
        .count({ dead_stops: '*' });
      const deadByVeh = new Map(dead.map((d: any) => [d.vehicle_id, { dead_min: Number(d.dead_min) || 0, dead_stops: Number(d.dead_stops) || 0 }]));

      // Paradas en tienda de trade + si hubo captura de auditoría (cercanía GPS ≤150m + ventana).
      const storeStops = await trx('logistics.vehicle_stops as st')
        .whereBetween('st.arrived_at', [start, end])
        .whereNotNull('st.matched_store_id')
        .groupBy('st.vehicle_id')
        .select('st.vehicle_id')
        .count({ store_stops: '*' })
        .select(trx.raw(`count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM public.daily_captures dc
          WHERE dc.hora_inicio BETWEEN st.arrived_at - interval '10 minutes' AND st.left_at + interval '10 minutes'
            AND dc.latitud IS NOT NULL AND dc.longitud IS NOT NULL
            AND 2 * 6371000 * asin(sqrt(
              power(sin(radians(dc.latitud::float8 - st.lat::float8) / 2), 2) +
              cos(radians(st.lat::float8)) * cos(radians(dc.latitud::float8)) *
              power(sin(radians(dc.longitud::float8 - st.lng::float8) / 2), 2)
            )) <= 150
        ))::int as captured_stops`));
      const storeByVeh = new Map(storeStops.map((r: any) => [r.vehicle_id, { store_stops: Number(r.store_stops) || 0, captured_stops: Number(r.captured_stops) || 0 }]));

      return summaries
        .map((s: any) => {
          const d = deadByVeh.get(s.vehicle_id) || { dead_min: 0, dead_stops: 0 };
          const st = storeByVeh.get(s.vehicle_id) || { store_stops: 0, captured_stops: 0 };
          const km = Number(s.km_driven) || 0;
          const custStops = Number(s.customer_stops) || 0;
          return {
            vehicle_id: s.vehicle_id,
            vehicle_plate: s.vehicle_plate ?? null,
            day,
            km_driven: km,
            moving_min: Number(s.moving_min) || 0,
            stopped_min: Number(s.stopped_min) || 0,
            dead_min: d.dead_min,
            offline_min: Number(s.offline_min) || 0,
            stops_count: Number(s.stops_count) || 0,
            customer_stops: custStops,
            dead_stops: d.dead_stops,
            km_per_customer_stop: custStops > 0 ? Math.round((km / custStops) * 100) / 100 : null,
            store_stops: st.store_stops,
            captured_stops: st.captured_stops,
            uncaptured_stops: Math.max(0, st.store_stops - st.captured_stops),
          };
        })
        .sort((a, b) => b.dead_min - a.dead_min);
    });
  }

  /**
   * LTV.19 — Cockpit de flota del día para el Mapa en Vivo. Sobre lo ya calculado
   * (vehicle_day_summary + vehicle_stops) agrega: idle (motor encendido detenido,
   * de vehicle_positions.ignition), combustible km/L y $/km (cargas de logística +
   * tickets OCR del vendedor) y las paradas fuera de tienda con geo para el mapa.
   */
  async cockpitForDay(day: string, fleet?: 'route' | 'logistics'): Promise<FleetCockpitBundle> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;

    return this.tk.run(async (trx) => {
      // ── Resumen del día por vehículo (km, tiempos, jornada, velocidad máx) ──
      const summaries = await trx('logistics.vehicle_day_summary as s')
        .leftJoin('logistics.vehicles as v', function () {
          this.on('v.tenant_id', 's.tenant_id').andOn('v.id', 's.vehicle_id');
        })
        .where('s.day', day)
        .modify((qb) => applyFleetFilter(qb, trx, fleet, 's.vehicle_id'))
        .select(
          's.vehicle_id', 'v.plate as vehicle_plate', 's.km_driven', 's.moving_min',
          's.stopped_min', 's.offline_min', 's.stops_count', 's.customer_stops',
          's.first_move_at', 's.last_stop_at', 's.max_speed_kmh',
        );

      // ── Ruta del vehículo (para atribuir tickets OCR por route_number) ──
      const trackers = await trx('logistics.trackers')
        .whereNotNull('vehicle_id')
        .whereNotNull('route_number')
        .whereNull('deleted_at')
        .distinct('vehicle_id', 'route_number');
      const vehRoute = new Map<string, number>();
      const routeToVeh = new Map<number, string>();
      for (const t of trackers as any[]) {
        vehRoute.set(t.vehicle_id, Number(t.route_number));
        routeToVeh.set(Number(t.route_number), t.vehicle_id);
      }

      // ── Idle: motor encendido (ignition) + velocidad ≈0, sumando el hueco hasta
      // el siguiente fix (tope IDLE_GAP_CAP_MIN). El LEAD corre sobre TODOS los fixes
      // ordenados por tiempo; el filtro ignición/velocidad se aplica al sumar, para
      // no saltar periodos en movimiento. vehicle_positions no tiene RLS → filtro tenant. ──
      const idleRes = await trx.raw(
        `SELECT vehicle_id, COALESCE(SUM(gap_min) FILTER (WHERE is_idle), 0) AS idle_min
           FROM (
             SELECT t.vehicle_id AS vehicle_id,
               (vp.ignition = true AND COALESCE(vp.speed_kmh, 0) <= 3) AS is_idle,
               LEAST(EXTRACT(EPOCH FROM (LEAD(vp.captured_at) OVER (PARTITION BY t.vehicle_id ORDER BY vp.captured_at) - vp.captured_at)) / 60.0, ${IDLE_GAP_CAP_MIN}) AS gap_min
             FROM logistics.vehicle_positions vp
             JOIN logistics.trackers t ON t.id = vp.tracker_id
             WHERE vp.tenant_id = public.current_tenant_id()
               AND t.vehicle_id IS NOT NULL
               AND vp.captured_at BETWEEN ? AND ?
           ) q
          GROUP BY vehicle_id`,
        [start, end],
      );
      const idleByVeh = new Map<string, number>(
        (idleRes.rows as any[]).map((r) => [r.vehicle_id, Math.round(Number(r.idle_min) || 0)]),
      );

      // ── Paradas muertas (≥DEAD, sin cliente) para productividad ──
      const dead = await trx('logistics.vehicle_stops')
        .whereBetween('arrived_at', [start, end])
        .where('is_customer', false)
        .where('minutes', '>=', DEAD_THRESHOLD_MIN)
        .groupBy('vehicle_id')
        .select('vehicle_id')
        .sum({ dead_min: 'minutes' })
        .count({ dead_stops: '*' });
      const deadByVeh = new Map(
        dead.map((d: any) => [d.vehicle_id, { dead_min: Number(d.dead_min) || 0, dead_stops: Number(d.dead_stops) || 0 }]),
      );

      // ── Paradas en tienda de trade ──
      const storeStops = await trx('logistics.vehicle_stops')
        .whereBetween('arrived_at', [start, end])
        .whereNotNull('matched_store_id')
        .groupBy('vehicle_id')
        .select('vehicle_id')
        .count({ store_stops: '*' });
      const storeByVeh = new Map(storeStops.map((r: any) => [r.vehicle_id, Number(r.store_stops) || 0]));

      // ── Paradas fuera de tienda (ni tienda ni cliente) con geo → mapa + alerta ──
      const offStops = await trx('logistics.vehicle_stops as st')
        .leftJoin('logistics.vehicles as v', function () {
          this.on('v.tenant_id', 'st.tenant_id').andOn('v.id', 'st.vehicle_id');
        })
        .whereBetween('st.arrived_at', [start, end])
        .whereNull('st.matched_customer_id')
        .whereNull('st.matched_store_id')
        .where('st.minutes', '>=', OFF_STORE_MIN)
        .select('st.vehicle_id', 'v.plate as vehicle_plate', 'st.lat', 'st.lng', 'st.arrived_at', 'st.left_at', 'st.minutes')
        .orderBy('st.minutes', 'desc');
      const offCountByVeh = new Map<string, number>();
      const dead_stops: FleetDeadStop[] = (offStops as any[]).map((r) => {
        offCountByVeh.set(r.vehicle_id, (offCountByVeh.get(r.vehicle_id) || 0) + 1);
        return {
          vehicle_id: r.vehicle_id,
          vehicle_plate: r.vehicle_plate ?? null,
          route_number: vehRoute.get(r.vehicle_id) ?? null,
          lat: Number(r.lat),
          lng: Number(r.lng),
          arrived_at: r.arrived_at,
          left_at: r.left_at ?? null,
          minutes: Number(r.minutes) || 0,
        };
      });

      // ── Combustible fuente 1: cargas formales de logística (por vehicle_id) ──
      const fuelTx = await trx('logistics.fuel_transactions')
        .whereBetween('loaded_at', [start, end])
        .whereNull('deleted_at')
        .groupBy('vehicle_id')
        .select('vehicle_id')
        .sum({ liters: 'liters' })
        .sum({ amount: 'amount' });
      const fuelByVeh = new Map<string, { liters: number; cost: number }>();
      for (const f of fuelTx as any[]) {
        fuelByVeh.set(f.vehicle_id, { liters: Number(f.liters) || 0, cost: Number(f.amount) || 0 });
      }

      // ── Combustible fuente 2: tickets OCR del vendedor (por route_code → vehículo) ──
      const rtFuel = await trx('commercial.route_tickets')
        .where('ticket_type', 'combustible')
        .where('ticket_date', day)
        .whereNull('deleted_at')
        .groupBy('route_code')
        .select('route_code')
        .sum({ liters: 'liters' })
        .sum({ total: 'total' });
      for (const r of rtFuel as any[]) {
        const routeNo = parseInt(String(r.route_code).replace(/\D/g, ''), 10);
        const vehId = Number.isFinite(routeNo) ? routeToVeh.get(routeNo) : undefined;
        if (!vehId) continue;
        const cur = fuelByVeh.get(vehId) || { liters: 0, cost: 0 };
        cur.liters += Number(r.liters) || 0;
        cur.cost += Number(r.total) || 0;
        fuelByVeh.set(vehId, cur);
      }

      const units: FleetCockpitUnit[] = summaries.map((s: any) => {
        const km = Number(s.km_driven) || 0;
        const d = deadByVeh.get(s.vehicle_id) || { dead_min: 0, dead_stops: 0 };
        const fuel = fuelByVeh.get(s.vehicle_id) || { liters: 0, cost: 0 };
        const custStops = Number(s.customer_stops) || 0;
        const maxSpeed = s.max_speed_kmh != null ? Number(s.max_speed_kmh) : null;
        const first = s.first_move_at ? new Date(s.first_move_at).getTime() : null;
        const last = s.last_stop_at ? new Date(s.last_stop_at).getTime() : null;
        const work_min = first != null && last != null && last > first ? Math.round((last - first) / 60000) : null;
        return {
          vehicle_id: s.vehicle_id,
          vehicle_plate: s.vehicle_plate ?? null,
          route_number: vehRoute.get(s.vehicle_id) ?? null,
          km_driven: km,
          moving_min: Number(s.moving_min) || 0,
          stopped_min: Number(s.stopped_min) || 0,
          idle_min: idleByVeh.get(s.vehicle_id) || 0,
          offline_min: Number(s.offline_min) || 0,
          dead_min: d.dead_min,
          dead_stops: d.dead_stops,
          off_store_stops: offCountByVeh.get(s.vehicle_id) || 0,
          customer_stops: custStops,
          store_stops: storeByVeh.get(s.vehicle_id) || 0,
          stops_count: Number(s.stops_count) || 0,
          first_move_at: s.first_move_at ?? null,
          last_stop_at: s.last_stop_at ?? null,
          work_min,
          max_speed_kmh: maxSpeed,
          speeding: maxSpeed != null && maxSpeed >= SPEEDING_KMH,
          liters: Math.round(fuel.liters * 100) / 100,
          fuel_cost: Math.round(fuel.cost * 100) / 100,
          km_per_liter: fuel.liters > 0 ? Math.round((km / fuel.liters) * 100) / 100 : null,
          cost_per_km: km > 0 && fuel.cost > 0 ? Math.round((fuel.cost / km) * 100) / 100 : null,
        };
      });

      units.sort((a, b) => b.off_store_stops - a.off_store_stops || b.idle_min - a.idle_min || b.km_driven - a.km_driven);

      const totals = units.reduce(
        (acc, u) => {
          acc.km += u.km_driven;
          acc.idle_min += u.idle_min;
          acc.dead_min += u.dead_min;
          acc.liters += u.liters;
          acc.fuel_cost += u.fuel_cost;
          acc.off_store_stops += u.off_store_stops;
          return acc;
        },
        { units: units.length, km: 0, idle_min: 0, dead_min: 0, liters: 0, fuel_cost: 0, off_store_stops: 0 },
      );
      totals.km = Math.round(totals.km * 100) / 100;
      totals.liters = Math.round(totals.liters * 100) / 100;
      totals.fuel_cost = Math.round(totals.fuel_cost * 100) / 100;

      return { date: day, units, dead_stops, totals };
    });
  }
}
