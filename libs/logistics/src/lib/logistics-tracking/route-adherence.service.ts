import { Injectable, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import { applyFleetFilter } from './trip-builder.service';

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
  planned: Array<{ customer_id: string; code: string | null; name: string | null; visit_sequence: number | null; has_coords: boolean; visited: boolean; captured: boolean }>;
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
      const withActivity: Array<{ vehicle_id: string }> = await trx('logistics.vehicle_day_summary as s')
        .where('s.day', day)
        .whereNotNull('s.vehicle_id')
        .modify((qb) => applyFleetFilter(qb, trx, 'route', 's.vehicle_id'))
        .distinct('s.vehicle_id as vehicle_id');
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
            .select('id as store_id', 'nombre as name', 'latitud')
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
