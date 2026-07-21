import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION, TenantContextService } from '@megadulces/platform-core';

/**
 * Horus — Sprint Horus.ACT.5: balanceo de carga entre rutas/personas.
 *
 * Nivela el TIEMPO que tarda cada persona en su ruta. Como daily_assignments es
 * 1 ruta/persona/día, persona = su ruta → nivelar = mover clientes de la ruta más
 * cargada a una vecina más liviana (redimensionar), validando cercanía geográfica,
 * hasta igualar tiempos y bajar el máximo. Mantiene el # de rutas ("separadas igual").
 *
 * Tiempo HÍBRIDO por ruta = Σ(minutos-visita por cliente, observados de
 * commercial.vendor_visits; fallback estimado) + traslado (NN-Haversine / velocidad).
 *
 * CERO LLM (motor decide, ADR-016/020). Co-piloto: `simulate` es read-only; `apply`
 * escribe (gate SUPERVISOR_AI_APROBAR) y guarda el estado previo en
 * commercial.route_rebalance_log para `undo`. KNEX_CONNECTION + tenant explícito.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPEED_KMH = 18; // velocidad urbana promedio (traslado entre paradas)
const TOL_MIN = 15; // tolerancia de desbalance para parar
const DEFAULT_VISIT_MIN = 8; // fallback si no hay historial de visita
const BORDER_FACTOR = 1.25; // solo mueve clientes "frontera" (≤ dist a su ruta × factor)

type Cust = { id: string; name: string; lat: number | null; lng: number | null; visitMin: number; visit_sequence: any };
type RouteBin = { routeId: string; salesRoute: string; vendorUserId: string | null; vendor: string | null; custs: Cust[] };

@Injectable()
export class RouteBalanceService {
  private readonly logger = new Logger(RouteBalanceService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    @Optional() private readonly tenantContext?: TenantContextService,
  ) {}

  private tenantId(user: any): string | undefined {
    return user?.tenant_id || this.tenantContext?.get()?.tenantId;
  }
  private userId(user: any): string | null {
    const id = user?.sub || user?.id || user?.userId || null;
    return id && UUID_RE.test(String(id)) ? String(id) : null;
  }

  private static haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  private static geo(custs: Cust[]): { lat: number; lng: number }[] {
    return custs.filter((c) => c.lat != null && c.lng != null).map((c) => ({ lat: c.lat as number, lng: c.lng as number }));
  }

  /** Km de recorrido por vecino-más-cercano sobre los clientes geolocalizados. */
  private static nnKm(pts: { lat: number; lng: number }[]): number {
    if (pts.length <= 2) {
      let m = 0;
      for (let i = 1; i < pts.length; i++) m += RouteBalanceService.haversineKm(pts[i - 1], pts[i]);
      return m;
    }
    const remaining = [...pts];
    const order = [remaining.shift()!];
    while (remaining.length) {
      const last = order[order.length - 1];
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = RouteBalanceService.haversineKm(last, remaining[i]);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      order.push(remaining.splice(bi, 1)[0]);
    }
    let km = 0;
    for (let i = 1; i < order.length; i++) km += RouteBalanceService.haversineKm(order[i - 1], order[i]);
    return km;
  }

  private static centroid(custs: Cust[]): { lat: number; lng: number } | null {
    const g = RouteBalanceService.geo(custs);
    if (!g.length) return null;
    return { lat: g.reduce((s, p) => s + p.lat, 0) / g.length, lng: g.reduce((s, p) => s + p.lng, 0) / g.length };
  }

  /** Tiempo total de una ruta en minutos = visitas + traslado (NN). */
  private static routeMin(custs: Cust[]): number {
    const visit = custs.reduce((s, c) => s + (c.visitMin || 0), 0);
    const travel = (RouteBalanceService.nnKm(RouteBalanceService.geo(custs)) / SPEED_KMH) * 60;
    return Math.round((visit + travel) * 10) / 10;
  }

  private static stddev(vals: number[]): number {
    if (!vals.length) return 0;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const v = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return Math.round(Math.sqrt(v) * 10) / 10;
  }

  /** Carga rutas del día D (ISODOW) con su vendedor y clientes + minutos-visita híbridos. */
  private async loadBins(tenantId: string, dow: number): Promise<RouteBin[]> {
    const asg = await this.knex('public.daily_assignments as da')
      .join('public.users as u', 'u.id', 'da.user_id')
      .join('public.catalogs as cat', function () {
        this.on('cat.id', '=', 'da.route_id').andOnVal('cat.catalog_id', '=', 'rutas').andOnNull('cat.deleted_at');
      })
      .where('da.tenant_id', tenantId)
      .where('da.day_of_week', dow)
      .select('da.user_id', 'u.nombre as vendor', 'cat.id as route_id', 'cat.value as sales_route');

    const bins: RouteBin[] = [];
    const seen = new Set<string>();
    for (const a of asg) {
      if (seen.has(a.sales_route)) continue; // una ruta = un bin (aunque haya duplicados de asignación)
      seen.add(a.sales_route);
      bins.push({ routeId: a.route_id, salesRoute: a.sales_route, vendorUserId: a.user_id, vendor: a.vendor, custs: [] });
    }
    if (!bins.length) return [];

    const routeValues = bins.map((b) => b.salesRoute);
    const custs = await this.knex('commercial.customers')
      .where('tenant_id', tenantId)
      .whereNull('deleted_at')
      .whereIn('sales_route', routeValues)
      .select('id', 'name', 'sales_route', 'latitude', 'longitude', 'visit_sequence');

    // Minutos-visita observados por cliente (vendor_visits cerradas); + mediana global fallback.
    const ids = custs.map((c: any) => c.id);
    const visitMap = new Map<string, number>();
    let globalAvg = DEFAULT_VISIT_MIN;
    if (ids.length) {
      const durs = await this.knex('commercial.vendor_visits')
        .where('tenant_id', tenantId)
        .whereNotNull('ended_at')
        .whereIn('customer_id', ids)
        .groupBy('customer_id')
        .select('customer_id', this.knex.raw('avg(extract(epoch from (ended_at - visited_at))/60.0) as m'));
      const all: number[] = [];
      for (const d of durs) {
        const m = Number(d.m);
        if (isFinite(m) && m > 0 && m < 180) {
          visitMap.set(String(d.customer_id), Math.round(m * 10) / 10);
          all.push(m);
        }
      }
      if (all.length) globalAvg = Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10;
    }

    const byRoute = new Map<string, RouteBin>();
    bins.forEach((b) => byRoute.set(b.salesRoute, b));
    for (const c of custs) {
      const bin = byRoute.get(c.sales_route);
      if (!bin) continue;
      bin.custs.push({
        id: c.id,
        name: c.name,
        lat: c.latitude != null ? Number(c.latitude) : null,
        lng: c.longitude != null ? Number(c.longitude) : null,
        visitMin: visitMap.get(String(c.id)) ?? globalAvg,
        visit_sequence: c.visit_sequence,
      });
    }
    return bins;
  }

  private snapshotBins(bins: RouteBin[]) {
    return bins.map((b) => ({
      sales_route: b.salesRoute,
      vendor: b.vendor,
      vendor_user_id: b.vendorUserId,
      customers: b.custs.length,
      time_min: RouteBalanceService.routeMin(b.custs),
    }));
  }

  /**
   * Núcleo: mueve clientes-frontera de la ruta más cargada a la más liviana hasta
   * nivelar. Devuelve los movimientos + estado antes/después + métricas. Puro (no escribe).
   */
  private computeBalance(bins: RouteBin[]): {
    before: any[];
    after: any[];
    moves: Array<{ customer_id: string; name: string; from_route: string; to_route: string }>;
    metrics: any;
  } {
    const before = this.snapshotBins(bins);
    const moves: Array<{ customer_id: string; name: string; from_route: string; to_route: string }> = [];

    if (bins.length >= 2) {
      const MAX_MOVES = Math.min(80, Math.max(10, Math.round(bins.reduce((s, b) => s + b.custs.length, 0) / 2)));
      const stuck = new Set<string>();
      for (let iter = 0; iter < MAX_MOVES * 2 && moves.length < MAX_MOVES; iter++) {
        const times = bins.map((b) => ({ b, t: RouteBalanceService.routeMin(b.custs) }));
        const active = times.filter((x) => !stuck.has(x.b.routeId));
        if (active.length < 2) break;
        active.sort((a, b) => b.t - a.t);
        const H = active[0];
        const L = active[active.length - 1];
        if (H.t - L.t <= TOL_MIN) break;

        const Lc = RouteBalanceService.centroid(L.b.custs);
        const Hc = RouteBalanceService.centroid(H.b.custs);
        if (!Lc || !Hc) {
          stuck.add(H.b.routeId);
          continue;
        }
        // Cliente "frontera" de H: geolocalizado, más cerca del centroide de L y no
        // absurdamente lejos de L respecto de su propia ruta (evita cruces feos).
        let best: { c: Cust; dL: number } | null = null;
        for (const c of H.b.custs) {
          if (c.lat == null || c.lng == null) continue;
          const p = { lat: c.lat, lng: c.lng };
          const dL = RouteBalanceService.haversineKm(p, Lc);
          const dH = RouteBalanceService.haversineKm(p, Hc);
          if (dL <= dH * BORDER_FACTOR && (!best || dL < best.dL)) best = { c, dL };
        }
        if (!best) {
          stuck.add(H.b.routeId);
          continue;
        }
        // No mover si dejaría a L por encima de H (evita oscilación).
        const projectedL = RouteBalanceService.routeMin([...L.b.custs, best.c]);
        if (projectedL >= H.t) {
          stuck.add(H.b.routeId);
          continue;
        }
        H.b.custs = H.b.custs.filter((x) => x.id !== best!.c.id);
        L.b.custs.push(best.c);
        moves.push({ customer_id: best.c.id, name: best.c.name, from_route: H.b.salesRoute, to_route: L.b.salesRoute });
        stuck.clear(); // el reparto cambió; reevaluar todas
      }
    }

    const after = this.snapshotBins(bins);
    const tb = before.map((r) => r.time_min);
    const ta = after.map((r) => r.time_min);
    const makespanBefore = tb.length ? Math.max(...tb) : 0;
    const makespanAfter = ta.length ? Math.max(...ta) : 0;
    const metrics = {
      routes: bins.length,
      moved: moves.length,
      makespan_before: makespanBefore,
      makespan_after: makespanAfter,
      stddev_before: RouteBalanceService.stddev(tb),
      stddev_after: RouteBalanceService.stddev(ta),
      improvement_pct: makespanBefore > 0 ? Math.round(((makespanBefore - makespanAfter) / makespanBefore) * 1000) / 10 : 0,
    };
    return { before, after, moves, metrics };
  }

  private resolveDow(dayOfWeek?: number | string): number {
    const n = Number(dayOfWeek);
    if (Number.isInteger(n) && n >= 1 && n <= 7) return n;
    // Default: ISODOW de hoy en TZ MX (se resuelve fuera con SQL; aquí caemos a lun=1 si no vino).
    return 0;
  }

  private async todayDow(): Promise<number> {
    const r = await this.knex.raw(`SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int AS d`);
    return Number(r?.rows?.[0]?.d ?? 1);
  }

  /** Read-only: simula el rebalanceo del día. */
  async simulate(user: any, dayOfWeek?: number | string) {
    const tenantId = this.tenantId(user);
    if (!tenantId) return { day_of_week: null, before: [], after: [], moves: [], metrics: null };
    const dow = this.resolveDow(dayOfWeek) || (await this.todayDow());
    const bins = await this.loadBins(tenantId, dow);
    const res = this.computeBalance(bins);
    return { day_of_week: dow, ...res };
  }

  /** Co-piloto (aprobar): recomputa server-side y APLICA los movimientos. Reversible. */
  async apply(user: any, dayOfWeek?: number | string) {
    const tenantId = this.tenantId(user);
    if (!tenantId) throw new BadRequestException('tenant no resuelto');
    const dow = this.resolveDow(dayOfWeek) || (await this.todayDow());
    const bins = await this.loadBins(tenantId, dow);
    const { before, after, moves, metrics } = this.computeBalance(bins);
    if (!moves.length) return { day_of_week: dow, applied: 0, moves, metrics, note: 'Ya está balanceado; sin movimientos.' };

    // Mapa salesRoute por cliente movido → destino. Snapshot previo para revertir.
    const movedIds = moves.map((m) => m.customer_id);
    const prev = await this.knex('commercial.customers')
      .where('tenant_id', tenantId)
      .whereIn('id', movedIds)
      .select('id', 'sales_route', 'visit_sequence');
    const previousState = prev.map((p: any) => ({ id: p.id, sales_route: p.sales_route, visit_sequence: p.visit_sequence }));

    // Aplica: cambia sales_route al destino y resetea visit_sequence (ACT.2 lo re-optimiza).
    let applied = 0;
    for (const mv of moves) {
      applied += await this.knex('commercial.customers')
        .where({ id: mv.customer_id, tenant_id: tenantId })
        .whereNull('deleted_at')
        .update({ sales_route: mv.to_route, visit_sequence: null, updated_at: this.knex.fn.now() });
    }

    await this.knex('commercial.route_rebalance_log').insert({
      tenant_id: tenantId,
      day_of_week: dow,
      applied_by: this.userId(user),
      moves: JSON.stringify(moves),
      previous_state: JSON.stringify(previousState),
      metrics: JSON.stringify(metrics),
      status: 'applied',
    });

    return { day_of_week: dow, applied, moves, before, after, metrics };
  }

  /** Revierte el último rebalanceo aplicado del día (restaura sales_route/visit_sequence). */
  async undo(user: any, dayOfWeek?: number | string) {
    const tenantId = this.tenantId(user);
    if (!tenantId) throw new BadRequestException('tenant no resuelto');
    const dow = this.resolveDow(dayOfWeek) || (await this.todayDow());
    const last = await this.knex('commercial.route_rebalance_log')
      .where({ tenant_id: tenantId, day_of_week: dow, status: 'applied' })
      .orderBy('applied_at', 'desc')
      .first();
    if (!last) throw new BadRequestException('No hay un rebalanceo aplicado para revertir en este día.');

    const prev =
      typeof last.previous_state === 'string' ? JSON.parse(last.previous_state) : last.previous_state || [];
    let restored = 0;
    for (const p of prev) {
      if (!UUID_RE.test(String(p.id))) continue;
      restored += await this.knex('commercial.customers')
        .where({ id: p.id, tenant_id: tenantId })
        .update({ sales_route: p.sales_route, visit_sequence: p.visit_sequence ?? null, updated_at: this.knex.fn.now() });
    }
    await this.knex('commercial.route_rebalance_log')
      .where({ id: last.id })
      .update({ status: 'reverted', reverted_at: this.knex.fn.now(), updated_at: this.knex.fn.now() });

    return { day_of_week: dow, restored, log_id: last.id };
  }
}
