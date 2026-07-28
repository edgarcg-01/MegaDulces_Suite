import { Injectable, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
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
    return this.tk.run((trx) => this.computeForVehicle(trx, vehicleId, day, start, end));
  }

  /**
   * LTV.1 batch — cumplimiento de TODA la flota en un día. Une los vehículos que
   * tuvieron embarque con ruta ese día + los que tuvieron actividad GPS, y calcula
   * el cumplimiento de cada uno en una sola transacción. Ordena por peor
   * cumplimiento (evaluables primero). Es la fuente de "Auditoría de ruta".
   */
  async forFleetDay(day: string): Promise<Array<AdherenceResult & { vehicle_plate: string | null }>> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) throw new BadRequestException('date inválida (YYYY-MM-DD)');
    const start = `${day}T00:00:00-06:00`;
    const end = `${day}T23:59:59.999-06:00`;

    return this.tk.run(async (trx) => {
      // Candidatos: vehículos con actividad GPS ese día (los que realmente
      // manejaron). El plan de cada uno sale de su tracker (route_number).
      const withActivity: Array<{ vehicle_id: string }> = await trx('logistics.vehicle_day_summary')
        .where('day', day)
        .whereNotNull('vehicle_id')
        .distinct('vehicle_id');
      const ids = Array.from(new Set(withActivity.map((r) => r.vehicle_id)));
      if (!ids.length) return [];

      const plateRows = await trx('logistics.vehicles').whereIn('id', ids).select('id', 'plate');
      const plateById = new Map(plateRows.map((v: any) => [v.id, v.plate ?? null]));

      const out: Array<AdherenceResult & { vehicle_plate: string | null }> = [];
      for (const id of ids) {
        const r = await this.computeForVehicle(trx, id, day, start, end);
        out.push({ ...r, vehicle_plate: plateById.get(id) ?? null });
      }
      // Evaluables primero, dentro de esos por peor cobertura; luego no-evaluables.
      return out.sort((a, b) => {
        if (a.evaluable !== b.evaluable) return a.evaluable ? -1 : 1;
        return (a.coverage_pct ?? 101) - (b.coverage_pct ?? 101);
      });
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
      // "Unidad de ruta": el número de ruta viene del tracker del vehículo (GPS
      // "R-21" o asignado a mano). El plan son los clientes de esa ruta, cuyo
      // vínculo real es el texto sales_route ("RUTA 21"), no route_id (vacío).
      const trk = await trx('logistics.trackers')
        .where({ vehicle_id: vehicleId })
        .whereNotNull('route_number')
        .first('route_number');
      const routeNumber: number | null = trk?.route_number ?? null;

      // Plan: clientes cuya sales_route normaliza al mismo número. El regex tolera
      // "RUTA 21" / "R-21" / "R0021" / "21" sin capturar "121".
      const planned = routeNumber != null
        ? await trx('commercial.customers')
            .whereNull('deleted_at')
            .whereRaw(`sales_route ~* ('(^|[^0-9])0*' || ?::text || '([^0-9]|$)')`, [String(routeNumber)])
            .select('id as customer_id', 'code', 'name', 'visit_sequence', 'latitude')
            .orderByRaw('visit_sequence asc nulls last')
        : [];
      const routeIds = routeNumber != null ? [`R-${routeNumber}`] : [];

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
    }
  }
}
