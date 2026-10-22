import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  BoardCustomer,
  BoardVendor,
  SetVendorTargetRequest,
  SetVendorTargetResponse,
  SupervisorBoardResponse,
  VisitMonitorRow,
} from '@megadulces/contracts';
import { TenantKnexService, TenantContextService, isPlatformAdminRole } from '@megadulces/platform-core';
import { parseYmd } from './visit-protocol.engine';
import { VisitMonitorService, resolveDay, routesForDays } from './visit-monitor.service';
import { RouteCatalog, resolveRouteScope } from './route-scope';
import { composeFreshness, evalInput, laneAt } from '../shared/freshness';
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
        // `[VP.2.3]` La venta del tablero sale de `kepler_ods.kdm1` por el carril `ods_live_hot`
        // (mismo carril que declara `commercial-analytics` para pólizas). Si el carril no late,
        // `laneAt` devuelve null y `composeFreshness` lo publica como NO MEDIDO — nunca como
        // fresco, que es justo lo que esta compuerta existe para impedir.
        freshness: composeFreshness([
          evalInput('ods_live_hot', 'Réplica ODS (venta Kepler)', await laneAt(trx, 'ods_live_hot'), 1),
        ]),
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
      const [sales, targets, extraDays] = await Promise.all([
        this.keplerSales(trx, [...codes], period.start, day.date),
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

  /** Venta Kepler por `CÓDIGO|día` (ver el comentario de la clase: qué incluye y qué no). */
  private async keplerSales(
    trx: Knex.Transaction,
    codes: string[],
    from: string,
    to: string,
  ): Promise<Map<string, RouteDaySale>> {
    const out = new Map<string, RouteDaySale>();
    if (!codes.length) return out;
    const r = await trx.raw(
      `SELECT upper(d.route_no) AS code, to_char(d.business_date, 'YYYY-MM-DD') AS day,
              sum(d.total) AS amount,
              count(DISTINCT (d.warehouse_code, d.caja, d.folio))::int AS tickets
         FROM analytics.v_kepler_vecinal_sales_docs d
        WHERE d.tenant_id = public.current_tenant_id()
          AND upper(d.route_no) = ANY(?::text[])
          AND d.business_date >= ?::date AND d.business_date <= ?::date
        GROUP BY 1, 2`,
      [codes, from, to],
    );
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
