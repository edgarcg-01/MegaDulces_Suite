import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdherenceResult {
  vehicle_id: string;
  day: string;
  route_ids: string[];
  evaluable: boolean; // false si ningún cliente del plan tiene coords
  planned_count: number;
  planned_with_coords: number;
  visited_count: number;
  skipped_count: number;
  off_route_count: number;
  coverage_pct: number | null; // visitados / plan-con-coords
  planned: Array<{ customer_id: string; code: string | null; name: string | null; visit_sequence: number | null; has_coords: boolean; visited: boolean }>;
  skipped: Array<{ customer_id: string; code: string | null; name: string | null }>;
  off_route_stops: Array<{ arrived_at: string; minutes: number; lat: number; lng: number }>;
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
  constructor(private readonly tk: TenantKnexService) {}

  async forVehicleDay(vehicleId: string, day: string): Promise<AdherenceResult> {
    if (!UUID_REGEX.test(vehicleId)) throw new BadRequestException('vehicle_id inválido');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;

    return this.tk.run(async (trx) => {
      // Rutas que la unidad sirvió ese día (por embarques).
      const shipRoutes: Array<{ route_id: string }> = await trx('logistics.shipments')
        .where({ vehicle_id: vehicleId, shipment_date: day })
        .whereNotNull('route_id')
        .distinct('route_id');
      const routeIds = shipRoutes.map((r) => r.route_id);

      // Plan: clientes de esas rutas, ordenados por visit_sequence.
      const planned = routeIds.length
        ? await trx('commercial.customers')
            .whereIn('route_id', routeIds)
            .whereNull('deleted_at')
            .select('id as customer_id', 'code', 'name', 'visit_sequence', 'latitude')
            .orderByRaw('visit_sequence asc nulls last')
        : [];

      // Real: paradas matcheadas a cliente ese día.
      const stops = await trx('logistics.vehicle_stops')
        .where({ vehicle_id: vehicleId })
        .whereBetween('arrived_at', [start, end])
        .select('matched_customer_id', 'arrived_at', 'minutes', 'lat', 'lng', 'is_customer');
      const visitedIds = new Set(stops.filter((s: any) => s.matched_customer_id).map((s: any) => s.matched_customer_id));
      const plannedIds = new Set(planned.map((p: any) => p.customer_id));

      const plannedRows = planned.map((p: any) => ({
        customer_id: p.customer_id,
        code: p.code ?? null,
        name: p.name ?? null,
        visit_sequence: p.visit_sequence ?? null,
        has_coords: p.latitude != null,
        visited: visitedIds.has(p.customer_id),
      }));
      const plannedWithCoords = plannedRows.filter((p) => p.has_coords);
      const skipped = plannedWithCoords.filter((p) => !p.visited).map((p) => ({ customer_id: p.customer_id, code: p.code, name: p.name }));
      const visitedCount = plannedWithCoords.filter((p) => p.visited).length;

      // Paradas fuera de ruta: parada real cuyo cliente no está en el plan (o sin cliente).
      const offRoute = stops
        .filter((s: any) => !s.matched_customer_id || !plannedIds.has(s.matched_customer_id))
        .map((s: any) => ({ arrived_at: s.arrived_at, minutes: s.minutes, lat: Number(s.lat), lng: Number(s.lng) }));

      const evaluable = plannedWithCoords.length > 0;
      return {
        vehicle_id: vehicleId,
        day,
        route_ids: routeIds,
        evaluable,
        planned_count: plannedRows.length,
        planned_with_coords: plannedWithCoords.length,
        visited_count: visitedCount,
        skipped_count: skipped.length,
        off_route_count: offRoute.length,
        coverage_pct: evaluable ? Math.round((visitedCount / plannedWithCoords.length) * 100) : null,
        planned: plannedRows,
        skipped,
        off_route_stops: offRoute,
      };
    });
  }
}
