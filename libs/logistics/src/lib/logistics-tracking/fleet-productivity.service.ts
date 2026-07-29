import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { applyFleetFilter } from './trip-builder.service';

// Parada improductiva: detenido ≥ este umbral SIN cliente matcheado (mismo criterio
// que IDLE_DEAD_THRESHOLD_MIN de reports.service para vendedores).
const DEAD_THRESHOLD_MIN = 20;

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
}
