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

      return summaries
        .map((s: any) => {
          const d = deadByVeh.get(s.vehicle_id) || { dead_min: 0, dead_stops: 0 };
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
          };
        })
        .sort((a, b) => b.dead_min - a.dead_min);
    });
  }
}
