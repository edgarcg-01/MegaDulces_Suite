import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  VecinalMonitorPeriod,
  VecinalVendorDetail,
  VecinalVendorRow,
  VecinalVendorsResponse,
} from '@megadulces/contracts';
import { relojMx } from '../warehouse-orders/warehouse-orders.engine';
import { cantidadMostrada } from '../presale-picking/presale-picking.engine';
import { PeriodoInvalido, periodoDe } from '../presale-picking/vecinal-monitor.engine';
import { VisitMonitorService, resolveDay, routesForDays } from './visit-monitor.service';
import { DEPARTAMENTO_VECINAL, RouteCatalog, loadRouteCatalog, resolveRouteScope, routeKey } from './route-scope';
import { SIN_MEDIR, attributeSales, progressPct } from './supervisor-board.engine';
import { ventaKeplerPorClienteDia, ventaKeplerPorRutaDia } from './supervisor-board.service';
import {
  conteosDeVisitas,
  metaDelPeriodo,
  visitasDelPeriodo,
  type PedidoLevantado,
  type VisitaCruda,
} from './vecinal-vendors.engine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUTA = 'commercial/vecinal-monitor';
/** Tope del detalle de un vendedor (visitas) y de su recorrido (puntos). Si se corta, se dice. */
const TOPE_VISITAS = 500;
const TOPE_PUNTOS = 3000;

interface Vendedor { user_id: string; name: string; warehouse_id: string | null }
type RutaDia = { date: string; route: string };

/**
 * `[MV.2]` Monitoreo vecinal — VENDEDORES. Sólo lectura.
 *
 * Quiénes: los `vendedor_ruta` que tuvieron al menos UNA ruta VECINAL en el periodo (la que eligieron
 * ese día o su agenda vigente: `routesForDays`, la misma regla del tablero y del monitoreo de visitas).
 * Su sucursal: la de sus rutas (`commercial.route_warehouses`) o la de su ficha; con eso se recorta al
 * alcance de quien consulta (`ScopeService`), como surtido y caja.
 *
 * Reutiliza, no reimplementa: la ruta del día (`routesForDays`), el tipo de ruta (`RouteCatalog`), la
 * venta cobrada en Kepler y su atribución a la ruta (`ventaKeplerPorRutaDia` + `attributeSales`, las
 * del tablero), la catorcena de la meta, y —en un periodo de UN día— el día del monitoreo de visitas
 * (`VisitMonitorService.buildDay`) para los clientes de la ruta y el estado de la ruta.
 */
@Injectable()
export class VecinalVendorsMonitorService {
  private readonly logger = new Logger(VecinalVendorsMonitorService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly monitor: VisitMonitorService,
  ) {}

  async vendors(query: Record<string, unknown> = {}): Promise<VecinalVendorsResponse> {
    const period = this.periodo(query);
    const me = this.tenantCtx.get()?.userId ?? null;
    if (!me) throw new ForbiddenException('Sin usuario en sesión');
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    if (almacenes !== null && almacenes.length === 0) return { period, scope: 'ninguno', route_options: [], rows: [] };
    const rutaPedida = String(query['route'] ?? '').trim();

    return this.tk.run(async (trx) => {
      const catalog = await loadRouteCatalog(trx);
      const { vendedores, rutasDe } = await this.universo(trx, period, catalog, almacenes);
      const route_options = [...new Set(vendedores.flatMap((v) => (rutasDe.get(v.user_id) ?? []).map((r) => r.route)))].sort((a, b) => a.localeCompare(b, 'es'));
      const lista = rutaPedida ? vendedores.filter((v) => (rutasDe.get(v.user_id) ?? []).some((r) => routeKey(r.route) === routeKey(rutaPedida))) : vendedores;
      const base: VecinalVendorsResponse = { period, scope: almacenes === null ? 'todos' : 'propios', route_options, rows: [] };
      if (!lista.length) return base;
      const ids = lista.map((v) => v.user_id);

      // ⛔ Kepler va ANTES y sola (abre un SAVEPOINT; en paralelo con otras consultas las tiraría).
      const codes = [...new Set(lista.flatMap((v) => (rutasDe.get(v.user_id) ?? []).map((r) => catalog.keplerCode(r.route)).filter((c): c is string => !!c)))];
      const venta = await ventaKeplerPorRutaDia(trx, codes, period.from, period.to, this.logger);
      // En orden, no en paralelo: es UNA transacción (una sola conexión).
      const aperturas = await this.aperturas(trx, ids, period);
      const pedidos = await this.pedidos(trx, ids, period, false);
      const metas = await this.metas(trx, ids, period);
      const gps = await this.gpsResumen(trx, ids, period);
      const dias = await this.diasDeRuta(trx, ids, period);
      const unDia = period.from === period.to ? await this.elDia(trx, me, period.from, ids) : null;

      base.rows = lista.map((v): VecinalVendorRow => {
        const rds = rutasDe.get(v.user_id) ?? [];
        const vs = visitasDelPeriodo(aperturas.get(v.user_id) ?? [], pedidos.get(v.user_id) ?? [], new Map());
        const c = conteosDeVisitas(vs);
        const cobro = attributeSales(rds, catalog, venta, SIN_MEDIR.sinRuta);
        const target = metaDelPeriodo(metas.get(v.user_id) ?? [], period.from, period.to);
        const g = gps.get(v.user_id);
        const dia = unDia?.get(v.user_id) ?? null;
        const momentos = [
          ...vs.flatMap((x) => [x.visited_at, x.ended_at, ...x.orders.map((o) => o.created_at)]),
          ...(dias.get(v.user_id) ?? []),
        ].filter((x): x is string => !!x).sort();
        return {
          user_id: v.user_id,
          name: v.name,
          routes: [...new Set(rds.map((r) => r.route))],
          days_on_route: new Set(rds.map((r) => r.date)).size,
          day_state: dia ? dia.day_state : null,
          route_started_at: dia?.started_at ?? null,
          route_finished_at: dia?.finished_at ?? null,
          planned_customers: dia ? dia.clientes : null,
          ...c,
          charged: cobro.sales.amount,
          charged_unmeasured_reason: cobro.sales.unmeasured_reason,
          target,
          progress_pct: progressPct(target, cobro.sales.amount),
          gps_points: g?.n ?? 0,
          gps_last_at: g?.ultimo ?? null,
          first_at: momentos[0] ?? null,
          last_at: momentos[momentos.length - 1] ?? null,
        };
      }).sort((a, b) => a.name.localeCompare(b.name, 'es'));
      return base;
    });
  }

  async vendorDetail(userId: string, query: Record<string, unknown> = {}): Promise<VecinalVendorDetail> {
    if (!UUID_RE.test(userId)) throw new BadRequestException('id inválido');
    const period = this.periodo(query);
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    if (almacenes !== null && almacenes.length === 0) throw new ForbiddenException('Tu usuario no tiene una sucursal asignada.');
    return this.tk.run(async (trx) => {
      const catalog = await loadRouteCatalog(trx);
      const { vendedores, rutasDe } = await this.universo(trx, period, catalog, almacenes, userId);
      const v = vendedores[0];
      if (!v) throw new NotFoundException('Ese vendedor no tiene ruta vecinal en tu alcance en el periodo.');
      const rds = rutasDe.get(userId) ?? [];
      const codes = [...new Set(rds.map((r) => catalog.keplerCode(r.route)).filter((c): c is string => !!c))];
      // Las dos lecturas de Kepler, una tras otra (cada una en su SAVEPOINT).
      const venta = await ventaKeplerPorRutaDia(trx, codes, period.from, period.to, this.logger);
      const porCliente = await ventaKeplerPorClienteDia(trx, codes, period.from, period.to, this.logger);
      const aperturas = await this.aperturas(trx, [userId], period);
      const pedidos = await this.pedidos(trx, [userId], period, true);
      const metas = await this.metas(trx, [userId], period);
      const puntos = await this.puntos(trx, userId, period);
      const visitas = visitasDelPeriodo(aperturas.get(userId) ?? [], pedidos.get(userId) ?? [], porCliente);
      const cobro = attributeSales(rds, catalog, venta, SIN_MEDIR.sinRuta);
      return {
        period,
        user_id: userId,
        name: v.name,
        target: metaDelPeriodo(metas.get(userId) ?? [], period.from, period.to),
        charged: cobro.sales.amount,
        charged_unmeasured_reason: cobro.sales.unmeasured_reason,
        ordered_total: conteosDeVisitas(visitas).ordered_total,
        total_visits: visitas.length,
        truncated: visitas.length > TOPE_VISITAS,
        visits: visitas.slice(0, TOPE_VISITAS),
        gps: puntos,
      };
    });
  }

  // ───────────────────────────── piezas ─────────────────────────────

  private periodo(query: Record<string, unknown>): VecinalMonitorPeriod {
    try {
      return periodoDe(query['from'] as string | undefined, query['to'] as string | undefined, relojMx(new Date()).fecha);
    } catch (e) {
      if (e instanceof PeriodoInvalido) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Los vendedores con ruta VECINAL en el periodo, recortados al alcance, y sus rutas-día vecinales. */
  private async universo(
    trx: Knex.Transaction, p: VecinalMonitorPeriod, catalog: RouteCatalog, almacenes: string[] | null, soloUserId?: string,
  ): Promise<{ vendedores: Vendedor[]; rutasDe: Map<string, RutaDia[]> }> {
    const q = trx('identity.users as u')
      .where('u.role_name', 'vendedor_ruta').where('u.activo', true).whereNull('u.deleted_at')
      .select('u.id as user_id', trx.raw(`coalesce(nullif(btrim(u.nombre), ''), u.username) AS name`), 'u.warehouse_id');
    if (soloUserId) q.where('u.id', soloUserId);
    const gente = (await q) as Vendedor[];
    if (!gente.length) return { vendedores: [], rutasDe: new Map() };
    const porDia = await routesForDays(trx, gente.map((g) => g.user_id), p.from, p.to);
    const rutasDe = new Map<string, RutaDia[]>();
    for (const [date, m] of porDia) {
      for (const [u, r] of m) {
        for (const route of r.routes) {
          if (catalog.kindOf(route) !== 'vecinal') continue;
          (rutasDe.get(u) ?? rutasDe.set(u, []).get(u)!).push({ date, route });
        }
      }
    }
    let vendedores = gente.filter((g) => (rutasDe.get(g.user_id) ?? []).length > 0);
    if (almacenes !== null && vendedores.length) {
      const sucursalDe = await this.sucursalesDeRutas(trx);
      const permitidas = new Set(almacenes);
      vendedores = vendedores.filter((g) => {
        const suyas = new Set<string>(g.warehouse_id ? [g.warehouse_id] : []);
        for (const r of rutasDe.get(g.user_id) ?? []) for (const w of sucursalDe.get(routeKey(r.route)) ?? []) suyas.add(w);
        return [...suyas].some((w) => permitidas.has(w));
      });
    }
    return { vendedores, rutasDe };
  }

  /** Sucursal de cada ruta (`commercial.route_warehouses`, por nombre de catálogo). */
  private async sucursalesDeRutas(trx: Knex.Transaction): Promise<Map<string, string[]>> {
    const r = await trx.raw(
      `SELECT c.value, rw.warehouse_id
         FROM commercial.route_warehouses rw
         JOIN trade.catalogs c ON c.id = rw.route_id AND c.tenant_id = rw.tenant_id
        WHERE rw.tenant_id = public.current_tenant_id() AND c.deleted_at IS NULL`,
    );
    const out = new Map<string, string[]>();
    for (const x of r.rows as { value: string; warehouse_id: string }[]) {
      const k = routeKey(x.value);
      (out.get(k) ?? out.set(k, []).get(k)!).push(x.warehouse_id);
    }
    return out;
  }

  private async aperturas(trx: Knex.Transaction, ids: string[], p: VecinalMonitorPeriod): Promise<Map<string, VisitaCruda[]>> {
    const rows = (await trx('commercial.vendor_visits as v')
      .leftJoin('commercial.customers as c', function () {
        this.on('c.id', '=', 'v.customer_id').andOn('c.tenant_id', '=', 'v.tenant_id');
      })
      .whereIn('v.user_id', ids)
      .whereRaw(`(v.visited_at AT TIME ZONE 'America/Mexico_City')::date BETWEEN ?::date AND ?::date`, [p.from, p.to])
      .orderBy('v.visited_at', 'asc')
      .select(
        'v.user_id', 'v.customer_id', 'c.code as customer_code', 'c.name as customer_name',
        trx.raw(`to_char((v.visited_at AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS date`),
        'v.visited_at', 'v.ended_at', 'v.had_order', 'v.no_sale_reason', 'v.notes', 'v.latitude', 'v.longitude',
      )) as Array<Record<string, unknown>>;
    const out = new Map<string, VisitaCruda[]>();
    for (const r of rows) {
      (out.get(r['user_id'] as string) ?? out.set(r['user_id'] as string, []).get(r['user_id'] as string)!).push({
        customer_id: r['customer_id'] as string,
        customer_code: (r['customer_code'] as string) ?? null,
        customer_name: (r['customer_name'] as string) ?? null,
        date: r['date'] as string,
        visited_at: isoDe(r['visited_at'])!,
        ended_at: isoDe(r['ended_at']),
        had_order: !!r['had_order'],
        no_sale_reason: (r['no_sale_reason'] as string) ?? null,
        notes: (r['notes'] as string) ?? null,
        latitude: r['latitude'] == null ? null : Number(r['latitude']),
        longitude: r['longitude'] == null ? null : Number(r['longitude']),
      });
    }
    return out;
  }

  /** Pedidos levantados por los vendedores en el periodo (no cancelados). Con productos sólo si se piden. */
  private async pedidos(trx: Knex.Transaction, ids: string[], p: VecinalMonitorPeriod, conLineas: boolean): Promise<Map<string, PedidoLevantado[]>> {
    const rows = (await trx('commercial.orders as o')
      .leftJoin('commercial.customers as c', function () {
        this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
      })
      .whereIn('o.user_id', ids)
      .whereNull('o.deleted_at')
      .whereNot('o.status', 'cancelled')
      .whereNot('o.status', 'draft')
      .whereRaw(`(o.created_at AT TIME ZONE 'America/Mexico_City')::date BETWEEN ?::date AND ?::date`, [p.from, p.to])
      .select(
        'o.id', 'o.code', 'o.user_id', 'o.customer_id', 'c.code as customer_code', 'c.name as customer_name', 'o.total', 'o.created_at',
        trx.raw(`to_char((o.created_at AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS date`),
      )) as Array<Record<string, unknown>>;
    const lineas = new Map<string, PedidoLevantado['lines']>();
    if (conLineas && rows.length) {
      const ls = (await trx('commercial.order_lines as l')
        .leftJoin('catalog.products as pr', 'pr.id', 'l.product_id')
        .whereIn('l.order_id', rows.map((r) => r['id'] as string))
        .orderBy(['l.order_id', 'l.line_number'])
        .select('l.order_id', 'pr.nombre', 'pr.sku', 'l.quantity', 'l.qty_unit', 'l.qty_factor', 'l.line_total')) as Array<Record<string, unknown>>;
      for (const l of ls) {
        const m = cantidadMostrada({ quantity: Number(l['quantity']), qty_unit: (l['qty_unit'] as string) ?? null, qty_factor: l['qty_factor'] == null ? null : Number(l['qty_factor']) });
        (lineas.get(l['order_id'] as string) ?? lineas.set(l['order_id'] as string, []).get(l['order_id'] as string)!).push({
          product_name: (l['nombre'] as string) ?? 'Producto', sku: (l['sku'] as string) ?? null, unit: m.unit, quantity: m.qty, line_total: Number(l['line_total']) || 0,
        });
      }
    }
    const out = new Map<string, PedidoLevantado[]>();
    for (const r of rows) {
      const u = r['user_id'] as string;
      (out.get(u) ?? out.set(u, []).get(u)!).push({
        order_id: r['id'] as string, code: r['code'] as string, customer_id: (r['customer_id'] as string) ?? null,
        customer_code: (r['customer_code'] as string) ?? null, customer_name: (r['customer_name'] as string) ?? null,
        date: r['date'] as string, created_at: isoDe(r['created_at'])!, total: Number(r['total']) || 0, lines: lineas.get(r['id'] as string) ?? [],
      });
    }
    return out;
  }

  /** Metas de las catorcenas que toca el periodo. */
  private async metas(trx: Knex.Transaction, ids: string[], p: VecinalMonitorPeriod): Promise<Map<string, Array<{ period_start: string; amount: number }>>> {
    const rows = (await trx('commercial.vendor_targets')
      .whereIn('user_id', ids).whereNull('deleted_at')
      .whereRaw('period_start <= ?::date AND period_start + 13 >= ?::date', [p.to, p.from])
      .select('user_id', trx.raw(`to_char(period_start, 'YYYY-MM-DD') AS period_start`), 'amount')) as Array<{ user_id: string; period_start: string; amount: string | number }>;
    const out = new Map<string, Array<{ period_start: string; amount: number }>>();
    for (const r of rows) (out.get(r.user_id) ?? out.set(r.user_id, []).get(r.user_id)!).push({ period_start: r.period_start, amount: Number(r.amount) });
    return out;
  }

  private async gpsResumen(trx: Knex.Transaction, ids: string[], p: VecinalMonitorPeriod): Promise<Map<string, { n: number; ultimo: string | null }>> {
    const r = await trx.raw(
      `SELECT user_id, count(*)::int AS n, max(captured_at) AS ultimo
         FROM public.route_location_pings
        WHERE tenant_id = public.current_tenant_id() AND user_id = ANY(?::uuid[])
          AND (captured_at AT TIME ZONE 'America/Mexico_City')::date BETWEEN ?::date AND ?::date
        GROUP BY user_id`,
      [ids, p.from, p.to],
    );
    return new Map((r.rows as Array<{ user_id: string; n: number; ultimo: Date | string | null }>).map((x) => [x.user_id, { n: x.n, ultimo: isoDe(x.ultimo) }]));
  }

  /** Inicio y fin de ruta registrados en el periodo (para la primera y última actividad). */
  private async diasDeRuta(trx: Knex.Transaction, ids: string[], p: VecinalMonitorPeriod): Promise<Map<string, string[]>> {
    const rows = (await trx('commercial.seller_route_days')
      .whereIn('user_id', ids).whereNull('deleted_at')
      .whereBetween('work_date', [p.from, p.to])
      .select('user_id', 'started_at', 'finished_at')) as Array<{ user_id: string; started_at: Date | string | null; finished_at: Date | string | null }>;
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const xs = [isoDe(r.started_at), isoDe(r.finished_at)].filter((x): x is string => !!x);
      (out.get(r.user_id) ?? out.set(r.user_id, []).get(r.user_id)!).push(...xs);
    }
    return out;
  }

  /** En un periodo de UN día: el día del monitoreo de visitas (clientes de la ruta y estado de la ruta). */
  private async elDia(
    trx: Knex.Transaction, me: string, date: string, ids: string[],
  ): Promise<Map<string, { clientes: number; day_state: 'sin_iniciar' | 'en_ruta' | 'finalizada'; started_at: string | null; finished_at: string | null }>> {
    const out = new Map<string, { clientes: number; day_state: 'sin_iniciar' | 'en_ruta' | 'finalizada'; started_at: string | null; finished_at: string | null }>();
    try {
      const day = await resolveDay(trx, date, me);
      const scope = await resolveRouteScope(trx, { me, seeAll: false, department: DEPARTAMENTO_VECINAL });
      const { response } = await this.monitor.buildDay(trx, { me, seeAll: true, day, scope, withGps: false });
      const quiero = new Set(ids);
      for (const v of response.vendors) {
        if (!quiero.has(v.user_id)) continue;
        out.set(v.user_id, { clientes: v.counts.clientes, day_state: v.day_state, started_at: v.started_at, finished_at: v.finished_at });
      }
    } catch (e) {
      // El día es ayuda: si no se puede armar, los clientes de la ruta se declaran sin dato (null).
      this.logger.warn(`[MV.2] no se pudo armar el día ${date}: ${(e as Error).message}`);
    }
    return out;
  }

  /** El recorrido del vendedor: los puntos de ubicación del periodo, en orden. */
  private async puntos(trx: Knex.Transaction, userId: string, p: VecinalMonitorPeriod): Promise<VecinalVendorDetail['gps']> {
    const where = `tenant_id = public.current_tenant_id() AND user_id = ?::uuid
      AND (captured_at AT TIME ZONE 'America/Mexico_City')::date BETWEEN ?::date AND ?::date`;
    const total = Number((await trx.raw(`SELECT count(*)::int AS n FROM public.route_location_pings WHERE ${where}`, [userId, p.from, p.to])).rows[0]?.n ?? 0);
    const r = await trx.raw(
      `SELECT lat, lng, captured_at, accuracy_m FROM public.route_location_pings WHERE ${where} ORDER BY captured_at ASC LIMIT ${TOPE_PUNTOS}`,
      [userId, p.from, p.to],
    );
    return {
      total,
      truncated: total > TOPE_PUNTOS,
      points: (r.rows as Array<{ lat: string | number; lng: string | number; captured_at: Date | string; accuracy_m: string | number | null }>).map((x) => ({
        lat: Number(x.lat), lng: Number(x.lng), at: isoDe(x.captured_at)!, accuracy_m: x.accuracy_m == null ? null : Number(x.accuracy_m),
      })),
    };
  }
}

function isoDe(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
