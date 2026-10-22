import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  VisitMonitorDayState,
  VisitMonitorResponse,
  VisitMonitorVendor,
} from '@megadulces/contracts';
import { TenantKnexService, TenantContextService, isPlatformAdminRole } from '@megadulces/platform-core';
import {
  VISIT_MAX_ACCURACY_M,
  VISIT_RADIUS_M,
  VisitCustomerFacts,
  VisitFact,
  addCounts,
  classifyVisit,
  countVisits,
  emptyCounts,
  haversineM,
  parseYmd,
} from './visit-protocol.engine';
import { ResolvedRouteScope, resolveRouteScope, routeScopeFor } from './route-scope';

/** Un grado de latitud ≈ 111 km: 0.02° ≈ 2.2 km. Más lejos que eso no se busca el GPS (es «no pasó»). */
const PING_BOX_DEG = 0.02;

/** El día consultado, ya resuelto en hora de México. */
export interface MonitorDay {
  today: string;
  date: string;
  /** Día ISO (1 = lunes … 7 = domingo). */
  dow: number;
  dayStart: Date | string;
  dayEnd: Date | string;
  /** `department_code` del PUESTO de quien consulta (`null` sin puesto). */
  myDepartment: string | null;
}

/**
 * Un solo viaje: hoy, la fecha pedida, sus límites en hora de México (como instantes, que se pasan
 * como valores y no como SQL) y el departamento del PUESTO de quien consulta. 400 si la fecha no ha
 * llegado. La fecha ya viene validada en forma (`parseYmd`).
 */
export async function resolveDay(trx: Knex.Transaction, dateParam: string | undefined, me: string): Promise<MonitorDay> {
  const { rows: [t] } = await trx.raw(
    `WITH h AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS today),
          d AS (SELECT h.today, coalesce(?::date, h.today) AS d FROM h)
     SELECT to_char(d.today, 'YYYY-MM-DD') AS today,
            d.d::timestamp AT TIME ZONE 'America/Mexico_City' AS day_start,
            (d.d + 1)::timestamp AT TIME ZONE 'America/Mexico_City' AS day_end,
            (SELECT p.department_code
               FROM identity.users u
               JOIN identity.positions p
                 ON p.tenant_id = u.tenant_id AND p.code = u.position_code AND p.deleted_at IS NULL
              WHERE u.id = ?::uuid AND u.tenant_id = public.current_tenant_id()) AS my_department
       FROM d`,
    [parseYmd(dateParam), me],
  );
  const today: string = t.today;
  const date: string = parseYmd(dateParam) ?? today;
  if (date > today) throw new BadRequestException('No se puede consultar un día que no ha llegado');
  return { today, date, dow: isoDow(date), dayStart: t.day_start, dayEnd: t.day_end, myDepartment: t.my_department ?? null };
}

export type RouteSource = VisitMonitorVendor['route_source'];
export interface DayRoutes {
  routes: string[];
  source: RouteSource;
}

/**
 * La ruta de cada quien, día por día, entre `from` y `to` (inclusive): la que escogió ese día
 * (`vendor_route_day_picks`, histórica) o, si no escogió, su agenda (`daily_assignments`) del día de
 * la semana — ⚠️ la agenda VIGENTE, no hay historia de la agenda. Mismo criterio que «Mi ruta».
 * Devuelve `fecha → persona → rutas` (valor de catálogo).
 */
export async function routesForDays(
  trx: Knex.Transaction,
  users: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, Map<string, DayRoutes>>> {
  const dates = datesBetween(from, to);
  const single = dates.length === 1;
  const out = new Map<string, Map<string, DayRoutes>>();
  for (const d of dates) {
    const m = new Map<string, DayRoutes>();
    for (const u of users) m.set(u, { routes: [], source: 'ninguna' });
    out.set(d, m);
  }
  if (!users.length || !dates.length) return out;
  const dows = [...new Set(dates.map(isoDow))];

  const picksQ = trx('commercial.vendor_route_day_picks as p')
    .join('public.catalogs as cat', 'cat.id', 'p.route_id')
    .whereIn('p.user_id', users as string[]);
  const agendaQ = trx('public.daily_assignments as da')
    .join('public.catalogs as cat', function (this: Knex.JoinClause) {
      this.on('cat.id', '=', 'da.route_id').andOnVal('cat.catalog_id', '=', 'rutas').andOnNull('cat.deleted_at');
    })
    .whereIn('da.user_id', users as string[]);
  const [picks, agenda] = await Promise.all([
    (single ? picksQ.where('p.work_date', from) : picksQ.where('p.work_date', '>=', from).where('p.work_date', '<=', to))
      .whereNull('p.deleted_at')
      .select('p.user_id', 'p.work_date', 'cat.value as route'),
    (single ? agendaQ.where('da.day_of_week', dows[0]) : agendaQ.whereIn('da.day_of_week', dows))
      .distinct('da.user_id', 'da.day_of_week', 'cat.value as route'),
  ]);

  // La elección del día manda (la primera, como «Mi ruta»).
  for (const p of picks as { user_id: string; work_date?: string | Date | null; route: string }[]) {
    // En la consulta de UN día la fecha es ésa aunque la fila no la traiga.
    const d = p.work_date == null ? (single ? from : null) : ymdOf(p.work_date);
    const r = d ? out.get(d)?.get(p.user_id) : undefined;
    if (r && r.source !== 'eleccion') { r.routes = [p.route]; r.source = 'eleccion'; }
  }
  for (const a of agenda as { user_id: string; day_of_week?: number | string | null; route: string }[]) {
    const dow = a.day_of_week == null ? null : Number(a.day_of_week);
    for (const d of dates) {
      if (dow == null ? !single : dow !== isoDow(d)) continue;
      const r = out.get(d)!.get(a.user_id);
      if (!r || r.source === 'eleccion') continue;
      r.source = 'agenda';
      if (!r.routes.includes(a.route)) r.routes.push(a.route);
    }
  }
  return out;
}

/** Opciones del armado del día (las comparten el monitoreo y el tablero del supervisor). */
export interface BuildDayOptions {
  me: string;
  seeAll: boolean;
  day: MonitorDay;
  /** Sólo esta persona (ya validada contra el equipo). */
  userId?: string;
  /** Recorte por tipo de ruta; `null` = sin recorte. */
  scope: ResolvedRouteScope | null;
  /** El GPS (cercanía, faltas) cuesta dos consultas: el tablero no lo necesita. */
  withGps: boolean;
}

interface CustomerRow {
  id: string;
  code: string;
  name: string;
  sales_route: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  visit_sequence: number | null;
}

interface VisitRow {
  user_id: string;
  customer_id: string;
  visited_at: string | Date;
  ended_at: string | Date | null;
  had_order: boolean;
  had_ticket: boolean;
  no_sale_reason: string | null;
  notes: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
}

/**
 * `[MCP.3.7]` Monitoreo de visitas del día para el supervisor de ventas.
 *
 * Todo se DERIVA al consultar; no hay tabla nueva ni proceso que corra al cierre:
 *  - la ruta de ese día: la que escogió (`vendor_route_day_picks`) o su agenda (`daily_assignments`),
 *    con el mismo criterio que «Mi ruta» (`vendorTodayRouteExistsSql`), pero para cualquier fecha;
 *  - las visitas (`vendor_visits`), los pedidos (`orders`) y el GPS de la jornada
 *    (`route_location_pings`, que la app ya manda);
 *  - el día se juzga (faltas) cuando la ruta se finalizó (`seller_route_days`) o la fecha ya pasó.
 *
 * Alcance: el supervisor ve a su equipo (`users.supervisor_id = él`) y a sí mismo; god-mode ve a
 * todos — el mismo criterio de `listVendors`. Fail-closed sin identidad.
 *
 * Alcance por tipo de ruta: si el PUESTO de quien consulta es de Ruta Vecinal
 * (`identity.positions.department_code = 'ruta_vecinal'`, p. ej. `supervisor_rv`), sólo entran
 * rutas con `trade.catalogs.route_kind = 'vecinal'` — y con ellas sólo los vendedores que ese día
 * tienen alguna, y sólo sus clientes. Sin puesto, o con otro, no se recorta nada. La respuesta lo
 * declara en `alcance`. La regla vive en `route-scope.ts` (una sola para todo el módulo); el
 * recorte de Ruta Directa NO se aplica aquí (ver `monitor`).
 *
 * ⚠️ Para una fecha pasada, la agenda que se usa es la VIGENTE (no hay historia de la agenda). La
 * elección del día sí es histórica. El contrato lo declara en `route_source`.
 */
@Injectable()
export class VisitMonitorService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async monitor(dateParam?: string, userIdParam?: string): Promise<VisitMonitorResponse> {
    const ctx = this.tenantCtx.get();
    const me = ctx?.userId || null;
    if (!me) throw new ForbiddenException('Sin usuario en sesión');
    const seeAll = isPlatformAdminRole(ctx?.roleName);
    if (dateParam != null && dateParam !== '' && !parseYmd(dateParam)) {
      throw new BadRequestException('date debe ser YYYY-MM-DD');
    }
    if (userIdParam && !/^[0-9a-f-]{36}$/i.test(userIdParam)) throw new BadRequestException('user_id inválido');

    return this.tk.run(async (trx) => {
      const day = await resolveDay(trx, dateParam, me);
      // ── Alcance por tipo de ruta ───────────────────────────────────────────────────────
      // Quien tiene un puesto de Ruta Vecinal sólo ve rutas vecinales (decisión de negocio). God-mode
      // no se recorta. ⚠️ El MONITOREO sólo aplica el recorte VECINAL: su contrato
      // (`VisitMonitorAlcance.tipo_ruta: 'vecinal' | null`) no sabe decir «Ruta directa», y recortar
      // sin poder declararlo sería afirmar «sin recorte» mientras se esconde lo vecinal. El recorte
      // de Ruta Directa vive en el tablero (`[MCP.3.9]`) y en Cartera; aquí espera a que el contrato
      // lo declare.
      const scope = routeScopeFor(day.myDepartment, seeAll) === 'vecinal'
        ? await resolveRouteScope(trx, { me, seeAll, department: day.myDepartment })
        : null;
      return (await this.buildDay(trx, { me, seeAll, day, userId: userIdParam, scope, withGps: true })).response;
    });
  }

  /**
   * El día armado: quiénes, su ruta, sus clientes y cómo quedó cada uno. Lo usan el monitoreo y el
   * tablero del supervisor (`SupervisorBoardService`), que es el mismo día visto de otra forma.
   * Devuelve también el equipo (sin recortar) para quien lo necesite.
   */
  async buildDay(
    trx: Knex.Transaction,
    opts: BuildDayOptions,
  ): Promise<{ response: VisitMonitorResponse; team: { user_id: string; name: string }[] }> {
    const { me, seeAll, day, scope, withGps } = opts;
    const userIdParam = opts.userId;
    const { today, date, dow, dayStart, dayEnd } = day;
    const recorta = !!scope && scope.scope !== null;
    // ── Quiénes ─────────────────────────────────────────────────────────────────────────
    const team = await this.people(trx, me, seeAll, date, dow);
    const allowed = new Set(team.map((o) => o.user_id));
    if (userIdParam && !allowed.has(userIdParam)) throw new ForbiddenException('Esa persona no es de tu equipo');
    // Con recorte la ruta de TODO el equipo se resuelve, para saber a quién ofrecer en el
    // filtro; sin él, sólo la de quienes se piden.
    const candidates = userIdParam && !recorta ? [userIdParam] : team.map((o) => o.user_id);
    const nameOf = new Map(team.map((o) => [o.user_id, o.name]));

    const base: VisitMonitorResponse = {
      date, today, radius_m: VISIT_RADIUS_M, max_accuracy_m: VISIT_MAX_ACCURACY_M,
      scope: seeAll ? 'todos' : 'equipo',
      alcance: scope?.scope === 'vecinal' ? { tipo_ruta: 'vecinal', etiqueta: scope.label } : { tipo_ruta: null, etiqueta: null },
      vendor_options: recorta ? [] : team, vendors: [], totals: emptyCounts(),
    };
    if (!candidates.length) return { response: base, team };

    // ── Ruta de cada quien ese día ─────────────────────────────────────────────────────
    const routesOf = (await routesForDays(trx, candidates, date, date)).get(date)!;

    // Con recorte: se queda SÓLO lo que entra en el alcance de cada quien, y quien no tenga
    // ninguna ruta del alcance ese día sale entero — de la lista, del filtro y de toda consulta
    // que sigue (su GPS, sus visitas y sus pedidos ya no se piden). Si pidió a alguien así,
    // simplemente no aparece.
    let users = userIdParam ? [userIdParam] : candidates;
    if (recorta) {
      for (const r of routesOf.values()) r.routes = r.routes.filter((x) => scope!.allows(x));
      const inScope = new Set(candidates.filter((u) => routesOf.get(u)!.routes.length > 0));
      base.vendor_options = team.filter((o) => inScope.has(o.user_id));
      users = users.filter((u) => inScope.has(u));
      if (!users.length) return { response: base, team };
    }
    const allRoutes = [...new Set(users.flatMap((u) => routesOf.get(u)!.routes))];

    // ── Hechos del día ──────────────────────────────────────────────────────────────────
    // El GPS va en el mismo lote: sólo depende de quiénes y del día, no de lo demás.
    const [routeCustomers, visits, orders, days, gps] = await Promise.all([
      allRoutes.length
        ? trx('commercial.customers as c')
            .whereNull('c.deleted_at')
            .whereIn('c.sales_route', allRoutes)
            .whereRaw(`(c.visit_days IS NULL OR cardinality(c.visit_days) = 0 OR c.visit_days @> ARRAY[?::smallint])`, [dow])
            .select('c.id', 'c.code', 'c.name', 'c.sales_route', 'c.latitude', 'c.longitude', 'c.visit_sequence')
        : Promise.resolve([] as CustomerRow[]),
      trx('commercial.vendor_visits as v')
        .whereIn('v.user_id', users)
        .where('v.visited_at', '>=', dayStart)
        .where('v.visited_at', '<', dayEnd)
        .orderBy('v.visited_at', 'asc')
        .select('v.user_id', 'v.customer_id', 'v.visited_at', 'v.ended_at', 'v.had_order', 'v.had_ticket',
          'v.no_sale_reason', 'v.notes', 'v.latitude', 'v.longitude'),
      trx('commercial.orders as o')
        .whereIn('o.user_id', users)
        .whereNull('o.deleted_at')
        .whereNot('o.status', 'draft')
        .where('o.created_at', '>=', dayStart)
        .where('o.created_at', '<', dayEnd)
        .distinct('o.user_id', 'o.customer_id'),
      trx('commercial.seller_route_days')
        .whereIn('user_id', users)
        .where('work_date', date)
        .whereNull('deleted_at')
        .select('user_id', 'started_at', 'finished_at'),
      // GPS de la jornada: cuántos puntos útiles mandó cada quien, y de cuándo a cuándo.
      !withGps ? Promise.resolve({ rows: [] }) : trx.raw(
        `SELECT p.user_id, count(*)::int AS n, min(p.captured_at) AS first_at, max(p.captured_at) AS last_at
           FROM public.route_location_pings p
          WHERE p.tenant_id = public.current_tenant_id()
            AND p.user_id = ANY(?::uuid[])
            AND p.captured_at >= ? AND p.captured_at < ?
            AND (p.accuracy_m IS NULL OR p.accuracy_m <= ?)
          GROUP BY p.user_id`,
        [users, dayStart, dayEnd, VISIT_MAX_ACCURACY_M],
      ),
    ]);

    // Clientes visitados fuera de su ruta: se traen aparte para no perder la visita.
    const known = new Map<string, CustomerRow>((routeCustomers as CustomerRow[]).map((c) => [c.id, c]));
    const missing = [...new Set((visits as VisitRow[]).map((v) => v.customer_id))].filter((id) => !known.has(id));
    if (missing.length) {
      const extra: CustomerRow[] = await trx('commercial.customers as c')
        .whereIn('c.id', missing)
        .select('c.id', 'c.code', 'c.name', 'c.sales_route', 'c.latitude', 'c.longitude', 'c.visit_sequence');
      for (const c of extra) known.set(c.id, c);
    }

    const gpsOf = new Map<string, { n: number; first_at: string | Date; last_at: string | Date }>(
      (gps.rows as { user_id: string; n: number; first_at: string; last_at: string }[]).map((g) => [g.user_id, g]),
    );

    // Lo más cerca que pasó cada quien de cada cliente CON ubicación de su ruta.
    const pairs: { user_id: string; customer_id: string; lat: number; lng: number }[] = [];
    for (const u of users) {
      if (!gpsOf.get(u)?.n) continue;
      const rs = new Set(routesOf.get(u)!.routes);
      for (const c of routeCustomers as CustomerRow[]) {
        if (!c.sales_route || !rs.has(c.sales_route)) continue;
        const lat = num(c.latitude);
        const lng = num(c.longitude);
        if (lat != null && lng != null) pairs.push({ user_id: u, customer_id: c.id, lat, lng });
      }
    }
    const nearest = new Map<string, number>();
    if (pairs.length) {
      const r = await trx.raw(
        `WITH c AS (
           SELECT * FROM jsonb_to_recordset(?::jsonb) AS x(user_id uuid, customer_id uuid, lat float8, lng float8)
         )
         SELECT c.user_id, c.customer_id,
                min(6371000 * 2 * asin(sqrt(
                  power(sin(radians((p.lat::float8 - c.lat) / 2)), 2) +
                  cos(radians(c.lat)) * cos(radians(p.lat::float8)) *
                  power(sin(radians((p.lng::float8 - c.lng) / 2)), 2)
                ))) AS d
           FROM c
           JOIN public.route_location_pings p
             ON p.user_id = c.user_id
            AND p.tenant_id = public.current_tenant_id()
            AND p.captured_at >= ? AND p.captured_at < ?
            AND (p.accuracy_m IS NULL OR p.accuracy_m <= ?)
            AND p.lat BETWEEN c.lat - ? AND c.lat + ?
            AND p.lng BETWEEN c.lng - ? AND c.lng + ?
          GROUP BY c.user_id, c.customer_id`,
        [JSON.stringify(pairs), dayStart, dayEnd, VISIT_MAX_ACCURACY_M, PING_BOX_DEG, PING_BOX_DEG, PING_BOX_DEG, PING_BOX_DEG],
      );
      for (const x of r.rows as { user_id: string; customer_id: string; d: number }[]) {
        nearest.set(`${x.user_id}|${x.customer_id}`, Number(x.d));
      }
    }

    const ordered = new Set((orders as { user_id: string; customer_id: string }[]).map((o) => `${o.user_id}|${o.customer_id}`));
    const dayOf = new Map((days as { user_id: string; started_at: string; finished_at: string | null }[]).map((d) => [d.user_id, d]));
    const visitsOf = new Map<string, VisitRow[]>();
    for (const v of visits as VisitRow[]) {
      const k = `${v.user_id}|${v.customer_id}`;
      (visitsOf.get(k) ?? visitsOf.set(k, []).get(k)!).push(v);
    }

    // ── Armar por vendedor ──────────────────────────────────────────────────────────────
    const vendors: VisitMonitorVendor[] = [];
    for (const u of users) {
      const route = routesOf.get(u)!;
      const rs = new Set(route.routes);
      const rd = dayOf.get(u);
      const dayState: VisitMonitorDayState = !rd ? 'sin_iniciar' : rd.finished_at ? 'finalizada' : 'en_ruta';
      const closed = date < today || dayState === 'finalizada';
      const g = gpsOf.get(u);
      const ctxDay = { closed, has_gps: !!g?.n, radius_m: VISIT_RADIUS_M };

      const onRoute = (routeCustomers as CustomerRow[])
        .filter((c) => c.sales_route && rs.has(c.sales_route))
        .sort((a, b) => (a.visit_sequence ?? 1e9) - (b.visit_sequence ?? 1e9) || a.name.localeCompare(b.name, 'es'));
      const onRouteIds = new Set(onRoute.map((c) => c.id));
      // Con recorte, una visita fuera de ruta sólo se lista si el cliente es de una ruta del
      // alcance: un cliente de otra ruta no es de este supervisor (sin ruta: sólo para el directo).
      const offRoute = [...known.values()].filter((c) => !onRouteIds.has(c.id) && visitsOf.has(`${u}|${c.id}`)
        && (!recorta || scope!.allows(c.sales_route)));

      const rows = [...onRoute.map((c) => [c, true] as const), ...offRoute.map((c) => [c, false] as const)].map(([c, isOn]) => {
        const k = `${u}|${c.id}`;
        const facts: VisitCustomerFacts = {
          customer_id: c.id,
          code: c.code,
          name: c.name,
          on_route: isOn,
          has_location: num(c.latitude) != null && num(c.longitude) != null,
          visit: mergeVisits(visitsOf.get(k) ?? [], c),
          ordered: ordered.has(k),
          nearest_m: nearest.get(k) ?? null,
        };
        return classifyVisit(facts, ctxDay);
      });
      // Sin ruta y sin visitas ese día: no se lista (no hay nada que supervisar).
      if (!rows.length && route.source === 'ninguna') continue;

      vendors.push({
        user_id: u,
        name: nameOf.get(u) ?? 'Sin nombre',
        routes: route.routes,
        route_source: route.source,
        day_state: dayState,
        started_at: iso(rd?.started_at),
        finished_at: iso(rd?.finished_at),
        closed,
        gps_points: g?.n ?? 0,
        gps_first_at: iso(g?.first_at),
        gps_last_at: iso(g?.last_at),
        counts: countVisits(rows),
        rows,
      });
    }
    vendors.sort((a, b) => b.counts.faltas - a.counts.faltas || a.name.localeCompare(b.name, 'es'));
    base.vendors = vendors;
    base.totals = vendors.reduce((acc, v) => addCounts(acc, v.counts), emptyCounts());
    return { response: base, team };
  }

  /** El supervisor y su equipo (o, en god-mode, todos los que tienen ruta o visitas ese día). */
  private async people(trx: Knex.Transaction, me: string, seeAll: boolean, date: string, dow: number) {
    let ids: string[];
    if (seeAll) {
      const r = await trx.raw(
        `SELECT user_id FROM public.daily_assignments WHERE day_of_week = ?
         UNION SELECT user_id FROM commercial.vendor_route_day_picks WHERE work_date = ? AND deleted_at IS NULL
         UNION SELECT DISTINCT user_id FROM commercial.vendor_visits
                WHERE visited_at >= (?::date)::timestamp AT TIME ZONE 'America/Mexico_City'
                  AND visited_at <  (?::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City'`,
        [dow, date, date, date],
      );
      ids = (r.rows as { user_id: string }[]).map((x) => x.user_id);
    } else {
      const team = await trx('public.users').where({ supervisor_id: me, activo: true }).select('id');
      ids = [me, ...team.map((t: { id: string }) => t.id)];
    }
    if (!ids.length) return [];
    const names = await trx('identity.users as u')
      .whereIn('u.id', ids)
      .select('u.id', trx.raw(`coalesce(nullif(btrim(u.nombre), ''), u.username) AS name`));
    return (names as { id: string; name: string }[])
      .map((n) => ({ user_id: n.id, name: n.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }
}

/**
 * Varias visitas del mismo cliente el mismo día cuentan como UNA: llegada = la primera, resultado =
 * la última que se cerró (abierta sólo si ninguna se cerró), pedido = si cualquiera lo tuvo. La
 * distancia es la de la primera apertura con GPS.
 */
export function mergeVisits(vs: readonly VisitRow[], c: Pick<CustomerRow, 'latitude' | 'longitude'>): VisitFact | null {
  if (!vs.length) return null;
  const first = vs[0];
  const last = vs[vs.length - 1];
  const lastClosed = [...vs].reverse().find((v) => v.ended_at) ?? null;
  const clat = num(c.latitude);
  const clng = num(c.longitude);
  let distance: number | null = null;
  for (const v of vs) {
    const vlat = num(v.latitude);
    const vlng = num(v.longitude);
    if (vlat != null && vlng != null && clat != null && clng != null) {
      distance = haversineM(vlat, vlng, clat, clng);
      break;
    }
  }
  return {
    visited_at: first.visited_at,
    // Una visita que ya se cerró NO se reabre porque el vendedor vuelva a abrir al cliente.
    ended_at: lastClosed?.ended_at ?? null,
    had_order: vs.some((v) => v.had_order),
    had_ticket: vs.some((v) => v.had_ticket),
    no_sale_reason: lastClosed?.no_sale_reason ?? null,
    notes: lastClosed?.notes ?? last.notes ?? null,
    distance_m: distance,
  };
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function iso(v: string | Date | null | undefined): string | null {
  return v == null ? null : v instanceof Date ? v.toISOString() : String(v);
}

/** Día ISO (1 = lunes … 7 = domingo) de un `YYYY-MM-DD`. */
export function isoDow(ymd: string): number {
  const d = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Los `YYYY-MM-DD` de `from` a `to`, inclusive (vacío si `to < from`). */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T12:00:00Z`).getTime();
  for (let t = new Date(`${from}T12:00:00Z`).getTime(); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Una columna `date` de Postgres como `YYYY-MM-DD` (pg la entrega como `Date` a medianoche local). */
function ymdOf(v: string | Date): string {
  if (typeof v === 'string') return v.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
}
