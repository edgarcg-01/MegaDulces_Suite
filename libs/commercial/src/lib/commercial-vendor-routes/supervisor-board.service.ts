import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  BoardCustomer,
  BoardVendor,
  SetVendorTargetRequest,
  SetVendorTargetResponse,
  SupervisorBoardResponse,
  VendorSummaryDay,
  VendorSummaryResponse,
  VendorAgendaDay,
  VendorRouteOption,
  VendorSummaryRoute,
  VisitMonitorRow,
} from '@megadulces/contracts';
import {
  FRESHNESS_UNKNOWN, TenantKnexService, TenantContextService, composeFreshness, evalInput, isPlatformAdminRole, laneAt,
} from '@megadulces/platform-core';
import type { Freshness } from '@megadulces/contracts';
import { parseYmd } from './visit-protocol.engine';
import { VisitMonitorService, datesBetween, resolveDay, routesForDays } from './visit-monitor.service';
import { RouteCatalog, resolveRouteScope } from './route-scope';
import {
  AttributedSales,
  RouteDaySale,
  SIN_MEDIR,
  attributeSales,
  catorcenaOf,
  isCatorcenaStart,
  progressPct,
  round2,
  saleKey,
  teamSales,
} from './supervisor-board.engine';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `numeric(14,2)`: 12 enteros. */
const MAX_AMOUNT = 999_999_999_999.99;
const VISITADO = new Set<VisitMonitorRow['status']>(['con_pedido', 'sin_pedido', 'abierta']);

/**
 * `[MCP.3.9]` Tablero del supervisor de ventas: por cada vendedor de SU equipo y SU tipo de ruta,
 * el día (inicio/fin de ruta, clientes visitados y no visitados) y la venta cobrada en Kepler del
 * día y de la catorcena, contra la meta que el supervisor captura.
 *
 * ── Qué se reutiliza ────────────────────────────────────────────────────────────────────────
 * El día lo arma `VisitMonitorService.buildDay` (el mismo equipo, la misma ruta del día, los mismos
 * clientes y visitas del monitoreo `[MCP.3.7]`), sin el GPS, que el tablero no usa. El alcance por
 * tipo de ruta es `route-scope.ts`, la misma regla que Cartera.
 *
 * ── ⭐ La fuente de la venta: `analytics.v_kepler_vecinal_sales_docs` ─────────────────────────
 * David pidió SÓLO la venta cobrada en Kepler. Se eligió esta vista porque:
 *  · es la vista CANÓNICA de la venta vecinal al grano de DOCUMENTO, derivada del ODS
 *    (`kepler_ods.kdm1`, sin importer: `[VEC.0]`/`[VEC.14]`), arbitrada contra `kdm1.c16` al
 *    centavo, y es la que ya usan Ventas por ruta y la conciliación vecinal;
 *  · se filtra por CÓDIGO DE RUTA (`route_no` = `kdm1.c12`, p. ej. `1V003`; los códigos vecinales
 *    son globales entre sucursales) y por rango de fechas, con el índice de `[VEC.2]`;
 *  · `total` = `c16`, CON impuestos (IVA + IEPS) — la unidad que declara el contrato; sólo
 *    `U-D-10` (ticket de contado: venta cobrada); la `U-D-12` de estas rutas re-factura el mismo
 *    ticket y queda fuera para no contarlo dos veces; cancelados (`c43 = 'C'`) fuera; cada
 *    documento en SU plaza; ticket = (sucursal, caja, folio).
 *
 * ⛔ **Para la Ruta Directa (camión) no hay venta cobrada en Kepler**: la camioneta cobra a bordo
 * (Wincaja / push, `analytics.v_rd_commission_sales`), y en Kepler sus códigos `1D00N` sólo traen
 * el embarque (`U-D-41`). Publicar esa otra fuente contradiría la decisión de David; publicar $0
 * mentiría. Se DECLARA: `amount: null` + `unmeasured_reason`. Lo mismo para cualquier ruta que no
 * sea vecinal o que no tenga código Kepler.
 *
 * ── A quién se le atribuye ──────────────────────────────────────────────────────────────────
 * La venta se atribuye a la RUTA, no a la persona: vendedor → sus rutas de cada día (la elegida o
 * su agenda VIGENTE) → código Kepler de la ruta (`trade.catalogs.erp_vendor_code`, o el que
 * encabeza el nombre) → venta de esa ruta ese día. Si un vendedor cubre una ruta ajena un día, la
 * venta de esa ruta ese día le cuenta a él.
 *
 * ── Quiénes aparecen ────────────────────────────────────────────────────────────────────────
 * Los del día (como el monitoreo) más quien tuvo alguna ruta del alcance en la catorcena aunque hoy
 * no tenga (para que su meta y su venta acumulada no desaparezcan el día que descansa). En
 * god-mode «el equipo» son quienes tienen ruta o visitas ese día (criterio del monitoreo).
 */
@Injectable()
export class SupervisorBoardService {
  private readonly logger = new Logger(SupervisorBoardService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly monitor: VisitMonitorService,
  ) {}

  async board(dateParam?: string, canSetTargets = false): Promise<SupervisorBoardResponse> {
    const ctx = this.tenantCtx.get();
    const me = ctx?.userId || null;
    if (!me) throw new ForbiddenException('Sin usuario en sesión');
    const seeAll = isPlatformAdminRole(ctx?.roleName);
    if (dateParam != null && dateParam !== '' && !parseYmd(dateParam)) {
      throw new BadRequestException('date debe ser YYYY-MM-DD');
    }

    return this.tk.run(async (trx) => {
      const day = await resolveDay(trx, dateParam, me);
      const rs = await resolveRouteScope(trx, { me, seeAll, department: day.myDepartment, withCatalog: true });
      const catalog = rs.catalog!;
      const period = catorcenaOf(day.date);

      const { response: view, team } = await this.monitor.buildDay(trx, {
        me, seeAll, day, scope: rs.scope ? rs : null, withGps: false,
      });
      const nameOf = new Map(team.map((t) => [t.user_id, t.name]));

      // ── Rutas de cada quien en la catorcena (hasta el día consultado), ya recortadas ─────
      const byDay = await routesForDays(trx, team.map((t) => t.user_id), period.start, day.date);
      const routeDaysOf = new Map<string, { date: string; route: string }[]>();
      for (const [d, m] of byDay) {
        for (const [u, r] of m) {
          for (const route of r.routes) {
            if (!rs.allows(route)) continue;
            (routeDaysOf.get(u) ?? routeDaysOf.set(u, []).get(u)!).push({ date: d, route });
          }
        }
      }

      const inView = new Map(view.vendors.map((v) => [v.user_id, v]));
      const listed = [...new Set([...inView.keys(), ...[...routeDaysOf.keys()].filter((u) => routeDaysOf.get(u)!.length)])];

      const base: SupervisorBoardResponse = {
        date: day.date,
        period,
        scope: rs.scope,
        scope_label: rs.label,
        can_set_targets: canSetTargets,
        vendors: [],
        totals: { vendors: 0, customers_total: 0, customers_visited: 0, sales_day: null, sales_period: null, target: null },
        generated_at: new Date().toISOString(),
        freshness: await this.frescura(trx),
      };
      if (!listed.length) return base;

      // ── Venta Kepler de las rutas medibles, y metas ─────────────────────────────────────
      const codes = new Set<string>();
      for (const u of listed) {
        for (const rd of routeDaysOf.get(u) ?? []) {
          const code = catalog.kindOf(rd.route) === 'vecinal' ? catalog.keplerCode(rd.route) : null;
          if (code) codes.add(code);
        }
      }
      const extras = listed.filter((u) => !inView.has(u));
      // ⛔ Kepler va ANTES y solo: abre un SAVEPOINT, y uno en paralelo con otras consultas de la
      // misma transacción las haría fallar con 25P02 si la vista revienta.
      const sales = await this.keplerSales(trx, [...codes], period.start, day.date);
      const [targets, extraDays] = await Promise.all([
        trx('commercial.vendor_targets')
          .whereIn('user_id', listed)
          .where('period_start', period.start)
          .whereNull('deleted_at')
          .select('user_id', 'amount') as Promise<{ user_id: string; amount: string | number }[]>,
        extras.length
          ? (trx('commercial.seller_route_days')
              .whereIn('user_id', extras)
              .where('work_date', day.date)
              .whereNull('deleted_at')
              .select('user_id', 'started_at', 'finished_at') as Promise<{ user_id: string; started_at: string | Date; finished_at: string | Date | null }[]>)
          : Promise.resolve([]),
      ]);
      const targetOf = new Map(targets.map((t) => [t.user_id, Number(t.amount)]));
      const extraDayOf = new Map(extraDays.map((d) => [d.user_id, d]));

      // ── Armar ───────────────────────────────────────────────────────────────────────────
      const partsDay: AttributedSales[] = [];
      const partsPeriod: AttributedSales[] = [];
      const vendors: BoardVendor[] = [];
      for (const u of listed) {
        const v = inView.get(u);
        const rds = routeDaysOf.get(u) ?? [];
        const todayRds = rds.filter((x) => x.date === day.date);
        const sd = attributeSales(todayRds, catalog, sales, SIN_MEDIR.sinRuta);
        const sp = attributeSales(rds, catalog, sales, SIN_MEDIR.sinRutaPeriodo);
        partsDay.push(sd);
        partsPeriod.push(sp);

        const customers = v ? toBoardCustomers(v.rows) : [];
        const extra = extraDayOf.get(u);
        const target = targetOf.get(u) ?? null;
        vendors.push({
          user_id: u,
          name: v?.name ?? nameOf.get(u) ?? 'Sin nombre',
          routes: routeLabels(v?.routes ?? todayRds.map((x) => x.route), catalog),
          day_state: v?.day_state ?? (!extra ? 'sin_iniciar' : extra.finished_at ? 'finalizada' : 'en_ruta'),
          started_at: v?.started_at ?? iso(extra?.started_at),
          finished_at: v?.finished_at ?? iso(extra?.finished_at),
          customers_total: customers.length,
          customers_visited: customers.filter((c) => c.visited_at != null).length,
          customers,
          sales_day: sd.sales,
          sales_period: sp.sales,
          target,
          progress_pct: progressPct(target, sp.sales.amount),
        });
      }
      vendors.sort((a, b) => a.name.localeCompare(b.name, 'es'));

      const withTarget = vendors.filter((x) => x.target != null);
      base.vendors = vendors;
      base.totals = {
        vendors: vendors.length,
        customers_total: vendors.reduce((s, x) => s + x.customers_total, 0),
        customers_visited: vendors.reduce((s, x) => s + x.customers_visited, 0),
        sales_day: teamSales(partsDay, sales),
        sales_period: teamSales(partsPeriod, sales),
        target: withTarget.length ? round2(withTarget.reduce((s, x) => s + (x.target ?? 0), 0)) : null,
      };
      return base;
    });
  }

  /**
   * Captura (o borra, con `amount: null`) la meta de la catorcena de un vendedor. Sólo de SU equipo
   * (`users.supervisor_id = quien captura`; god-mode: cualquiera del tenant) y de SU alcance (que
   * tenga alguna ruta del alcance en esa catorcena). La meta propia no se captura: no es supervisión.
   */
  /**
   * De cuándo es la venta (VP.2.3): del carril que mantiene al día el ODS de Kepler. Si no se puede
   * medir, se declara desconocida; nunca se afirma «fresco».
   */
  private async frescura(trx: Knex.Transaction): Promise<Freshness> {
    try {
      const carril = await laneAt(trx, 'ods_live_hot');
      return composeFreshness([evalInput('ods_live_hot', 'Ventas de Kepler (ODS)', carril, 1)]);
    } catch {
      return FRESHNESS_UNKNOWN;
    }
  }

  async setTarget(dto: SetVendorTargetRequest): Promise<SetVendorTargetResponse> {
    const ctx = this.tenantCtx.get();
    const me = ctx?.userId || null;
    if (!me) throw new ForbiddenException('Sin usuario en sesión');
    const seeAll = isPlatformAdminRole(ctx?.roleName);

    const userId = typeof dto?.user_id === 'string' ? dto.user_id : '';
    if (!UUID_RX.test(userId)) throw new BadRequestException('user_id inválido');
    const periodStart = typeof dto?.period_start === 'string' ? dto.period_start : '';
    if (!isCatorcenaStart(periodStart)) {
      const hint = parseYmd(periodStart) ? ` (la de esa fecha abre el ${catorcenaOf(periodStart).start})` : '';
      throw new BadRequestException(`period_start debe ser el sábado YYYY-MM-DD que abre una catorcena${hint}`);
    }
    const raw = dto?.amount;
    if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw))) {
      throw new BadRequestException('amount debe ser un número (o null para borrar la meta)');
    }
    if (raw !== null && raw < 0) throw new BadRequestException('amount no puede ser negativo');
    if (raw !== null && raw > MAX_AMOUNT) throw new BadRequestException('amount fuera de rango');
    const amount = raw === null ? null : round2(raw);

    return this.tk.run(async (trx) => {
      // ── ¿Es de SU equipo? ───────────────────────────────────────────────────────────────
      if (userId === me && !seeAll) throw new ForbiddenException('Tu propia meta la captura tu jefe, no tú');
      const q = trx('public.users').where({ id: userId, activo: true });
      const person = await (seeAll ? q : q.where('supervisor_id', me)).select('id').first();
      if (!person) throw new ForbiddenException('Esa persona no es de tu equipo');

      // ── ¿Es de SU alcance? ──────────────────────────────────────────────────────────────
      const rs = await resolveRouteScope(trx, { me, seeAll });
      if (rs.scope !== null) {
        const end = catorcenaOf(periodStart).end;
        const days = await routesForDays(trx, [userId], periodStart, end);
        const ok = [...days.values()].some((m) => (m.get(userId)?.routes ?? []).some((r) => rs.allows(r)));
        if (!ok) throw new ForbiddenException(`Esa persona no tiene rutas de tu alcance (${rs.label}) en esa catorcena`);
      }

      if (amount === null) {
        await trx('commercial.vendor_targets')
          .where({ user_id: userId, period_start: periodStart })
          .whereNull('deleted_at')
          .update({ deleted_at: trx.fn.now(), deleted_by: me, updated_at: trx.fn.now(), updated_by: me });
        return { user_id: userId, period_start: periodStart, amount: null };
      }
      // Upsert atómico contra el índice único parcial (una meta VIVA por vendedor y catorcena).
      await trx.raw(
        `INSERT INTO commercial.vendor_targets (tenant_id, user_id, period_start, amount, created_by, updated_by)
         VALUES (public.current_tenant_id(), ?::uuid, ?::date, ?::numeric, ?::uuid, ?::uuid)
         ON CONFLICT (tenant_id, user_id, period_start) WHERE deleted_at IS NULL
         DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [userId, periodStart, amount, me, me],
      );
      return { user_id: userId, period_start: periodStart, amount };
    });
  }

  /**
   * `[MCP.3.10]` Resumen de UN vendedor de tu equipo para «Asignar rutas»: meta de la catorcena contra
   * lo cobrado, y cada día de la catorcena hasta `date` (visitados, con pedido, cobrado).
   *
   * Cada día se arma con `VisitMonitorService.buildDay` acotado a esa persona — el MISMO armado que el
   * tablero —, así que las cifras de un día cuadran con lo que el tablero mostró ese día. Son a lo
   * más 14 días de una sola persona (sin GPS). La venta se pide UNA vez para toda la catorcena.
   *
   * Alcance: igual que la meta (`setTarget`): sólo tu equipo (god-mode: cualquiera del tenant), y
   * con el recorte por tipo de ruta de tu puesto.
   */
  async vendorSummary(userIdParam: string, dateParam?: string, canSetTargets = false): Promise<VendorSummaryResponse> {
    const ctx = this.tenantCtx.get();
    const me = ctx?.userId || null;
    if (!me) throw new ForbiddenException('Sin usuario en sesión');
    const seeAll = isPlatformAdminRole(ctx?.roleName);
    const userId = typeof userIdParam === 'string' ? userIdParam : '';
    if (!UUID_RX.test(userId)) throw new BadRequestException('user_id inválido');
    if (dateParam != null && dateParam !== '' && !parseYmd(dateParam)) {
      throw new BadRequestException('date debe ser YYYY-MM-DD');
    }

    return this.tk.run(async (trx) => {
      // ── ¿Es de SU equipo? (el mismo criterio que la meta) ───────────────────────────────────
      const q = trx('public.users').where({ id: userId, activo: true });
      const person = await (seeAll ? q : q.where('supervisor_id', me)).select('id', 'nombre', 'username', 'zona_id').first();
      if (!person) throw new ForbiddenException('Esa persona no es de tu equipo');

      const day = await resolveDay(trx, dateParam, me);
      const rs = await resolveRouteScope(trx, { me, seeAll, department: day.myDepartment, withCatalog: true });
      const catalog = rs.catalog!;
      const period = catorcenaOf(day.date);

      // ── Cada día de la catorcena, con el armado del tablero ─────────────────────────────────
      const armados: { date: string; routes: string[]; customers: BoardCustomer[]; name: string | null }[] = [];
      for (const d of datesBetween(period.start, day.date)) {
        const md = d === day.date ? day : await resolveDay(trx, d, me);
        try {
          const { response, team } = await this.monitor.buildDay(trx, {
            me, seeAll, day: md, userId, scope: rs.scope ? rs : null, withGps: false,
          });
          const v = response.vendors.find((x) => x.user_id === userId);
          // El nombre sale del equipo, no del vendedor del día: quien no tuvo ruta no viene en vendors.
          const name = v?.name ?? team.find((x) => x.user_id === userId)?.name ?? null;
          armados.push({ date: d, routes: v?.routes ?? [], customers: v ? toBoardCustomers(v.rows) : [], name });
        } catch (e) {
          // En god-mode «el equipo» de un día es quien tuvo ruta o visitas ese día: no estar = no trabajó.
          if (!(e instanceof ForbiddenException)) throw e;
          armados.push({ date: d, routes: [], customers: [], name: null });
        }
      }

      // ── Venta Kepler de la catorcena (una sola consulta) y meta ─────────────────────────────
      const routeDays = armados.flatMap((a) => a.routes.map((route) => ({ date: a.date, route })));
      const codes = new Set<string>();
      for (const rd of routeDays) {
        const code = catalog.kindOf(rd.route) === 'vecinal' ? catalog.keplerCode(rd.route) : null;
        if (code) codes.add(code);
      }
      const sales = await this.keplerSales(trx, [...codes], period.start, day.date);
      const [target] = await Promise.all([
        trx('commercial.vendor_targets')
          .where({ user_id: userId, period_start: period.start })
          .whereNull('deleted_at')
          .select('amount')
          .first() as Promise<{ amount: string | number } | undefined>,
      ]);

      const days: VendorSummaryDay[] = armados.map((a) => ({
        date: a.date,
        routes: routeLabels(a.routes, catalog),
        customers_total: a.customers.length,
        customers_visited: a.customers.filter((c) => c.visited_at != null).length,
        orders: a.customers.filter((c) => c.result === 'con_pedido').length,
        sales: attributeSales(a.routes.map((route) => ({ date: a.date, route })), catalog, sales, SIN_MEDIR.sinRuta).sales,
      }));
      const salesPeriod = attributeSales(routeDays, catalog, sales, SIN_MEDIR.sinRutaPeriodo).sales;
      const targetAmount = target ? Number(target.amount) : null;

      // ── Lo que tiene configurado: las rutas del día (o del último día con ruta) ──────────────
      // La ruta que se configura es la de su AGENDA; sin agenda, la del último día que trabajó.
      const { agenda, options } = await this.agendaOf(trx, userId, person.zona_id ?? null, rs, catalog);
      const ultimo = [...armados].reverse().find((a) => a.routes.length);
      const rutas = agenda.length ? [...new Set(agenda.map((x) => x.route))] : ultimo?.routes ?? [];
      const routes: VendorSummaryRoute[] = rutas.length ? await this.routesInfo(trx, rutas, catalog) : [];

      return {
        user_id: userId,
        name: [...armados].reverse().find((a) => a.name)?.name ?? (person.nombre || person.username || 'Sin nombre'),
        date: day.date,
        period,
        target: targetAmount,
        sales_period: salesPeriod,
        progress_pct: progressPct(targetAmount, salesPeriod.amount),
        can_set_targets: canSetTargets,
        routes,
        days: days.reverse(),
        agenda,
        route_options: options,
        freshness: await this.frescura(trx),
      };
    });
  }

  /**
   * `[MCP.3.10]` La agenda semanal del vendedor y las rutas que se le pueden poner. Las opciones son
   * las que acepta `DailyAssignmentsService.create` (activa y de su zona, o sin zona) recortadas al
   * tipo de ruta de quien consulta: el supervisor de Ruta Vecinal sólo ofrece vecinales.
   */
  private async agendaOf(
    trx: Knex.Transaction, userId: string, zonaId: string | null, rs: { scope: unknown; allows(route: string): boolean },
    catalog: RouteCatalog,
  ): Promise<{ agenda: VendorAgendaDay[]; options: VendorRouteOption[] }> {
    const a = await trx.raw(
      `SELECT da.id AS assignment_id, da.day_of_week, da.route_id, cat.value AS route
         FROM public.daily_assignments da
         JOIN public.catalogs cat ON cat.id = da.route_id AND cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
        WHERE da.user_id = ?::uuid
        ORDER BY da.day_of_week`,
      [userId],
    );
    const o = await trx.raw(
      `SELECT cat.id, cat.value AS route
         FROM public.catalogs cat
        WHERE cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
          AND (?::uuid IS NULL OR cat.parent_id IS NULL OR cat.parent_id = ?::uuid)
        ORDER BY cat.value`,
      [zonaId, zonaId],
    );
    const agenda = (a.rows as VendorAgendaDay[]).map((x) => ({ ...x, day_of_week: Number(x.day_of_week) }));
    const options = (o.rows as { id: string; route: string }[])
      .filter((x) => !rs.scope || rs.allows(x.route))
      .map((x) => ({ id: x.id, route: x.route, code: catalog.keplerCode(x.route) }));
    return { agenda, options };
  }

  /** Código, sucursal de surtido y clientes de cada ruta (valor de catálogo). */
  private async routesInfo(trx: Knex.Transaction, rutas: string[], catalog: RouteCatalog): Promise<VendorSummaryRoute[]> {
    const [sucursales, clientes] = await Promise.all([
      trx('trade.catalogs as r')
        .leftJoin('commercial.route_warehouses as rw', function () {
          this.on('rw.route_id', '=', 'r.id').andOn('rw.tenant_id', '=', 'r.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'rw.warehouse_id').andOn('w.tenant_id', '=', 'rw.tenant_id');
        })
        .where('r.catalog_id', 'rutas')
        .whereNull('r.deleted_at')
        .whereIn('r.value', rutas)
        .select('r.value as route', 'w.name as warehouse_name') as Promise<{ route: string; warehouse_name: string | null }[]>,
      trx('commercial.customers')
        .whereNull('deleted_at')
        .whereIn('sales_route', rutas)
        .groupBy('sales_route')
        .select('sales_route', trx.raw('count(*)::int AS n')) as Promise<{ sales_route: string; n: number }[]>,
    ]);
    const whOf = new Map(sucursales.map((s) => [s.route, s.warehouse_name ?? null]));
    const nOf = new Map(clientes.map((c) => [c.sales_route, Number(c.n) || 0]));
    return rutas.map((route) => ({
      route,
      code: catalog.keplerCode(route) ?? null,
      warehouse_name: whOf.get(route) ?? null,
      customers: nOf.get(route) ?? 0,
    }));
  }

  /** Venta Kepler por `CÓDIGO|día` (ver el comentario de la clase: qué incluye y qué no). */
  private async keplerSales(
    trx: Knex.Transaction,
    codes: string[],
    from: string,
    to: string,
  ): Promise<Map<string, RouteDaySale> | null> {
    const out = new Map<string, RouteDaySale>();
    if (!codes.length) return out;
    // `[MCP.3.10]` Lectura OPCIONAL en un SAVEPOINT: si la vista no responde (o no existe, como en
    // la base local, que no tiene el ODS), la venta se DECLARA sin medir (`null`) y el resto del
    // tablero sigue. Antes tiraba la pantalla entera con un 500.
    let r: { rows: unknown[] };
    try {
      r = await trx.transaction((sp) => sp.raw(
        `SELECT upper(d.route_no) AS code, to_char(d.business_date, 'YYYY-MM-DD') AS day,
                sum(d.total) AS amount,
                count(DISTINCT (d.warehouse_code, d.caja, d.folio))::int AS tickets
           FROM analytics.v_kepler_vecinal_sales_docs d
          WHERE d.tenant_id = public.current_tenant_id()
            AND upper(d.route_no) = ANY(?::text[])
            AND d.business_date >= ?::date AND d.business_date <= ?::date
          GROUP BY 1, 2`,
        [codes, from, to],
      ));
    } catch (e) {
      this.logger.warn(`Venta Kepler sin medir (${from}..${to}): ${(e as Error)?.message ?? e}`);
      return null;
    }
    for (const x of r.rows as { code: string; day: string; amount: string | number; tickets: number }[]) {
      out.set(saleKey(x.code, x.day), { amount: Number(x.amount) || 0, tickets: Number(x.tickets) || 0 });
    }
    return out;
  }
}

/** Visitados primero (por hora de llegada), luego los no visitados en el orden de la ruta. */
export function toBoardCustomers(rows: readonly VisitMonitorRow[]): BoardCustomer[] {
  const visited = rows.filter((r) => VISITADO.has(r.status) && r.visited_at)
    .sort((a, b) => String(a.visited_at).localeCompare(String(b.visited_at)));
  const pending = rows.filter((r) => !(VISITADO.has(r.status) && r.visited_at));
  return [...visited, ...pending].map((r) => {
    const isVisited = VISITADO.has(r.status) && !!r.visited_at;
    return {
      customer_id: r.customer_id,
      name: r.name,
      code: r.code || null,
      visited_at: isVisited ? r.visited_at : null,
      result: isVisited ? (r.status as BoardCustomer['result']) : null,
      reason: isVisited ? r.no_sale_reason : null,
    };
  });
}

/** Código Kepler de cada ruta (`1V003`) o, si no tiene, su nombre de catálogo. */
function routeLabels(routes: readonly string[], catalog: RouteCatalog): string[] {
  return [...new Set(routes.map((r) => catalog.keplerCode(r) ?? r))];
}

function iso(v: string | Date | null | undefined): string | null {
  return v == null ? null : v instanceof Date ? v.toISOString() : String(v);
}
