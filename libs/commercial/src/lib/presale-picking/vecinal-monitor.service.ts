import { BadRequestException, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantKnexService } from '@megadulces/platform-core';
import type {
  PresalePickReport,
  PresaleReviewResult,
  VecinalCashierOrder,
  VecinalCashiersResponse,
  VecinalMonitorPeriod,
  VecinalOrdersResponse,
  VecinalPickerOrder,
  VecinalPickersResponse,
} from '@megadulces/contracts';
import { relojMx } from '../warehouse-orders/warehouse-orders.engine';
import {
  PeriodoInvalido,
  cajaAjusto,
  iso,
  lineasDelPedido,
  minutos,
  periodoDe,
  resumenCajeras,
  resumenSurtidores,
  type PickParaMonitor,
  type RenglonVivoMonitor,
} from './vecinal-monitor.engine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** El alcance por sucursal: quien tiene sucursal en su ficha ve la suya; oficinas, la que elijan. */
const RUTA = 'commercial/vecinal-monitor';
/** Tope del detalle de UNA persona. Si se corta, la respuesta lo dice (`truncated`). */
const TOPE_DETALLE = 200;

type Fila = PickParaMonitor & { total: string | number; customer_name: string | null; seller_name: string | null; finished_by_name: string | null };

/**
 * `[MV.1]` Monitoreo vecinal — surtidores y cajeras. Sólo LEE `commercial.presale_picks` (el registro
 * propio del surtido y de la revisión en caja) con su pedido; no escribe nada.
 *
 * Qué pedidos entran: la preventa de ruta (`delivery_type = 'route'` con fecha de entrega), la misma
 * que llega a la bandeja del surtidor. El día de cada cosa es su fecha en hora de México: para el
 * surtidor, cuándo EMPEZÓ a surtir; para la cajera, cuándo REVISÓ.
 */
@Injectable()
export class VecinalMonitorService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly scope: ScopeService,
  ) {}

  async pickers(query: Record<string, unknown> = {}): Promise<VecinalPickersResponse> {
    const period = this.periodo(query);
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    if (almacenes !== null && almacenes.length === 0) return { period, scope: 'ninguno', rows: [] };
    return this.tk.run(async (trx) => {
      const filas = await this.picks(trx, almacenes).modify((q) => this.enPeriodo(q, 'pp.started_at', period));
      return { period, scope: almacenes === null ? 'todos' : 'propios', rows: resumenSurtidores(filas as Fila[]) };
    });
  }

  async pickerOrders(userId: string, query: Record<string, unknown> = {}): Promise<VecinalOrdersResponse<VecinalPickerOrder>> {
    if (!UUID_RE.test(userId)) throw new BadRequestException('id inválido');
    const period = this.periodo(query);
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    if (almacenes !== null && almacenes.length === 0) return { period, total: 0, truncated: false, data: [] };
    return this.tk.run(async (trx) => {
      const filas = (await this.picks(trx, almacenes)
        .where('pp.started_by', userId)
        .modify((q) => this.enPeriodo(q, 'pp.started_at', period))
        .orderBy('pp.started_at', 'desc')
        .limit(TOPE_DETALLE + 1)) as Fila[];
      const corte = filas.slice(0, TOPE_DETALLE);
      const lineas = await this.lineas(trx, corte);
      return {
        period,
        total: filas.length > TOPE_DETALLE ? await this.contar(trx, almacenes, 'pp.started_by', userId, 'pp.started_at', period) : filas.length,
        truncated: filas.length > TOPE_DETALLE,
        data: corte.map((f) => ({
          order_id: f.order_id,
          code: f.code,
          customer_name: f.customer_name,
          seller_name: f.seller_name,
          started_at: iso(f.started_at)!,
          finished_at: iso(f.finished_at),
          minutes: minutos(f.started_at, f.finished_at),
          outcome: f.outcome,
          adjusted_by_cashier: cajaAjusto(f.review),
          lines: lineas(f),
        })),
      };
    });
  }

  async cashiers(query: Record<string, unknown> = {}): Promise<VecinalCashiersResponse> {
    const period = this.periodo(query);
    const vacio = { count: 0, should_charge: 0, oldest_finished_at: null };
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    if (almacenes !== null && almacenes.length === 0) return { period, scope: 'ninguno', rows: [], pending: vacio };
    return this.tk.run(async (trx) => {
      const filas = await this.picks(trx, almacenes).whereNotNull('pp.reviewed_at').modify((q) => this.enPeriodo(q, 'pp.reviewed_at', period));
      // Lo que espera revisión HOY, sin importar el periodo (lo mismo que ve la cajera en su bandeja).
      const pend = (await this.porRevisar(trx, almacenes)
        .first(
          trx.raw('count(*)::int AS n'),
          trx.raw('coalesce(sum(o.total), 0)::float8 AS total'),
          trx.raw('min(pp.finished_at) AS mas_viejo'),
        )) as { n: number; total: number; mas_viejo: Date | string | null } | undefined;
      return {
        period,
        scope: almacenes === null ? 'todos' : 'propios',
        rows: resumenCajeras(filas as Fila[]),
        pending: { count: Number(pend?.n ?? 0), should_charge: Math.round(Number(pend?.total ?? 0) * 100) / 100, oldest_finished_at: iso(pend?.mas_viejo ?? null) },
      };
    });
  }

  async cashierOrders(userId: string, query: Record<string, unknown> = {}): Promise<VecinalOrdersResponse<VecinalCashierOrder>> {
    if (!UUID_RE.test(userId)) throw new BadRequestException('id inválido');
    const period = this.periodo(query);
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    if (almacenes !== null && almacenes.length === 0) return { period, total: 0, truncated: false, data: [] };
    return this.tk.run(async (trx) => {
      const filas = (await this.picks(trx, almacenes)
        .where('pp.reviewed_by', userId)
        .modify((q) => this.enPeriodo(q, 'pp.reviewed_at', period))
        .orderBy('pp.reviewed_at', 'desc')
        .limit(TOPE_DETALLE + 1)) as Fila[];
      const corte = filas.slice(0, TOPE_DETALLE);
      const lineas = await this.lineas(trx, corte);
      return {
        period,
        total: filas.length > TOPE_DETALLE ? await this.contar(trx, almacenes, 'pp.reviewed_by', userId, 'pp.reviewed_at', period) : filas.length,
        truncated: filas.length > TOPE_DETALLE,
        data: corte.map((f) => ({
          order_id: f.order_id,
          code: f.code,
          customer_name: f.customer_name,
          picker_name: f.finished_by_name ?? f.started_by_name,
          finished_at: iso(f.finished_at)!,
          reviewed_at: iso(f.reviewed_at),
          wait_minutes: minutos(f.finished_at, f.reviewed_at),
          total_before: f.review ? Number(f.review.total_before) : null,
          should_charge: f.review ? Number(f.review.total_after) : Number(f.total),
          lines: lineas(f),
        })),
      };
    });
  }

  // ───────────────────────────── base ─────────────────────────────

  private periodo(query: Record<string, unknown>): VecinalMonitorPeriod {
    try {
      return periodoDe(query['from'] as string | undefined, query['to'] as string | undefined, relojMx(new Date()).fecha);
    } catch (e) {
      if (e instanceof PeriodoInvalido) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** El día en hora de México, como en el resto del surtido (`relojMx`). */
  private enPeriodo(q: Knex.QueryBuilder, columna: string, p: VecinalMonitorPeriod): void {
    q.whereRaw(`(${columna} AT TIME ZONE 'America/Mexico_City')::date BETWEEN ?::date AND ?::date`, [p.from, p.to]);
  }

  /** Los surtidos de preventa de ruta del alcance, con su pedido, cliente y vendedor. */
  private picks(trx: Knex.Transaction, almacenes: string[] | null): Knex.QueryBuilder {
    const q = trx('commercial.presale_picks as pp')
      .join('commercial.orders as o', function () {
        this.on('o.id', '=', 'pp.order_id').andOn('o.tenant_id', '=', 'pp.tenant_id');
      })
      .leftJoin('commercial.customers as c', function () {
        this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
      })
      .leftJoin('identity.users as u', 'u.id', 'o.user_id')
      .whereNull('o.deleted_at')
      .where('o.delivery_type', 'route')
      .whereNotNull('o.requested_delivery_date');
    if (almacenes !== null) q.whereIn('o.warehouse_id', almacenes);
    return q.select(
      'pp.order_id', 'o.code', 'o.total', 'pp.started_by', 'pp.started_by_name', 'pp.started_at',
      'pp.finished_by_name', 'pp.finished_at', 'pp.outcome', 'pp.report',
      'pp.reviewed_by', 'pp.reviewed_by_name', 'pp.reviewed_at', 'pp.review',
      'c.name as customer_name',
      trx.raw(`coalesce(nullif(btrim(u.nombre), ''), u.username) AS seller_name`),
    );
  }

  /** Lo surtido que espera a la caja: la misma condición que la bandeja de la revisión. */
  private porRevisar(trx: Knex.Transaction, almacenes: string[] | null): Knex.QueryBuilder {
    const q = trx('commercial.presale_picks as pp')
      .join('commercial.orders as o', function () {
        this.on('o.id', '=', 'pp.order_id').andOn('o.tenant_id', '=', 'pp.tenant_id');
      })
      .whereNull('o.deleted_at')
      .where('o.status', 'confirmed')
      .where('o.delivery_type', 'route')
      .whereNotNull('pp.finished_at')
      .whereNull('pp.reviewed_at')
      .where('pp.review_required', true);
    if (almacenes !== null) q.whereIn('o.warehouse_id', almacenes);
    return q;
  }

  private async contar(
    trx: Knex.Transaction, almacenes: string[] | null, quien: string, userId: string, cuando: string, p: VecinalMonitorPeriod,
  ): Promise<number> {
    const r = (await this.picks(trx, almacenes).clearSelect().where(quien, userId).modify((q) => this.enPeriodo(q, cuando, p))
      .count({ n: '*' }).first()) as { n: string | number } | undefined;
    return Number(r?.n ?? 0);
  }

  /** Arma, para cada pedido, sus productos como los dejó cada etapa (una sola lectura de renglones). */
  private async lineas(trx: Knex.Transaction, filas: Fila[]): Promise<(f: Fila) => ReturnType<typeof lineasDelPedido>> {
    const ids = filas.map((f) => f.order_id);
    const vivos = ids.length
      ? ((await trx('commercial.order_lines as l')
          .leftJoin('catalog.products as p', 'p.id', 'l.product_id')
          .whereIn('l.order_id', ids)
          .orderBy(['l.order_id', 'l.line_number'])
          .select('l.order_id', 'l.id as line_id', 'l.product_id', 'p.nombre as product_name', 'p.sku', 'l.quantity', 'l.qty_unit', 'l.qty_factor')) as Array<{
          order_id: string; line_id: string; product_id: string; product_name: string | null; sku: string | null;
          quantity: string | number; qty_unit: string | null; qty_factor: string | number | null;
        }>)
      : [];
    const porPedido = new Map<string, RenglonVivoMonitor[]>();
    for (const v of vivos) {
      (porPedido.get(v.order_id) ?? porPedido.set(v.order_id, []).get(v.order_id)!).push({
        line_id: v.line_id, product_id: v.product_id, product_name: v.product_name ?? 'Producto', sku: v.sku ?? null,
        quantity: Number(v.quantity), qty_unit: v.qty_unit, qty_factor: v.qty_factor == null ? null : Number(v.qty_factor),
      });
    }
    // El SKU de lo que el surtido borró (ya no tiene renglón) sale del catálogo, por producto.
    const borrados = [...new Set(filas.flatMap((f) => ((f.report as PresalePickReport | null)?.removed ?? []).map((r) => r.restore?.product_id).filter((x): x is string => !!x)))];
    const sku = new Map<string, string>(
      borrados.length
        ? ((await trx('catalog.products').whereIn('id', borrados).select('id', 'sku')) as Array<{ id: string; sku: string | null }>)
            .filter((p) => !!p.sku).map((p) => [p.id, String(p.sku)])
        : [],
    );
    return (f) => lineasDelPedido(
      { report: (f.report as PresalePickReport | null) ?? null, review: (f.review as PresaleReviewResult | null) ?? null },
      porPedido.get(f.order_id) ?? [],
      (id) => (id ? sku.get(id) ?? null : null),
    );
  }
}
