import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * Reports y analytics sobre `logistics.*`.
 *
 * Estrategia: on-the-fly aggregation. No MV todavía — el volumen de embarques
 * por tenant es bajo en beta (decenas/día max). Cuando un tenant supere 1k
 * embarques activos, considerar materializar como `analytics.mv_logistics_*`.
 *
 * Solo cuenta shipments con `status IN ('entregado', 'cerrado')` para revenue
 * y cost real (programados/en_ruta son pipeline, no realizados).
 */

export interface DateRangeQuery {
  from?: string;
  to?: string;
}

export interface ProfitabilityQuery extends DateRangeQuery {
  vehicle_id?: string;
  route_id?: string;
  limit?: number;
}

const REALIZED_STATUSES = ['entregado', 'cerrado'];

@Injectable()
export class LogisticsAnalyticsService {
  constructor(private readonly tk: TenantKnexService) {}

  // ── Overview ─────────────────────────────────────────────────────────────

  /**
   * Overview agregado por rango. Si no se da rango, devuelve totales históricos.
   * Calcula: total shipments, revenue, cost, margin, margin%, total km, cost/km.
   */
  async overview(q: DateRangeQuery) {
    return this.tk.run(async (trx) => {
      let base = trx('logistics.shipments as s')
        .leftJoin('logistics.shipment_expenses as e', 'e.shipment_id', 's.id')
        .whereNull('s.deleted_at')
        .whereIn('s.status', REALIZED_STATUSES);

      if (q.from) base = base.where('s.shipment_date', '>=', q.from);
      if (q.to) base = base.where('s.shipment_date', '<=', q.to);

      const [row] = await base.select([
        trx.raw('COUNT(DISTINCT s.id)::int AS total_shipments'),
        trx.raw('COALESCE(SUM(s.freight_revenue), 0)::numeric AS total_revenue'),
        trx.raw('COALESCE(SUM(s.cargo_value), 0)::numeric AS total_cargo_value'),
        trx.raw('COALESCE(SUM(e.total_cost), 0)::numeric AS total_cost'),
        trx.raw('COALESCE(SUM(e.operating_subtotal), 0)::numeric AS total_operating_cost'),
        trx.raw('COALESCE(SUM(s.actual_km), 0)::int AS total_km'),
        trx.raw('COALESCE(SUM(s.boxes_count), 0)::int AS total_boxes'),
      ]);

      const revenue = Number(row.total_revenue);
      const cost = Number(row.total_cost);
      const km = Number(row.total_km);
      const shipments = Number(row.total_shipments);
      const margin = revenue - cost;
      const marginPct = revenue > 0 ? +((margin / revenue) * 100).toFixed(2) : 0;
      const costPerKm = km > 0 ? +(cost / km).toFixed(2) : 0;
      const avgKm = shipments > 0 ? +(km / shipments).toFixed(2) : 0;

      return {
        period: { from: q.from || null, to: q.to || null },
        currency: 'MXN',
        shipments: {
          count: shipments,
          total_boxes: Number(row.total_boxes),
          total_km: km,
          avg_km_per_shipment: avgKm,
        },
        revenue: {
          freight: revenue,
          cargo_value_moved: Number(row.total_cargo_value),
        },
        cost: {
          total: cost,
          operating: Number(row.total_operating_cost),
          per_km: costPerKm,
        },
        margin: {
          gross: +margin.toFixed(2),
          gross_pct: marginPct,
        },
      };
    });
  }

  // ── KPI cards (J14: valor + delta vs período previo + serie diaria) ────────

  /**
   * Alimenta las tarjetas KPI con micro-gráficas del dashboard. 1 request, sin N+1.
   * Devuelve por KPI: `value` (rango actual), `delta_pct` (vs período previo de igual
   * largo) y `series` (serie diaria alineada al rango, 0 en días sin data).
   * Solo cuenta shipments realizados (entregado/cerrado), igual que `overview`.
   */
  async kpiCards(q: DateRangeQuery) {
    const to = q.to || new Date().toISOString().slice(0, 10);
    const from = q.from || (() => { const d = new Date(to); d.setDate(d.getDate() - 29); return d.toISOString().slice(0, 10); })();

    // Período previo de igual largo (para el delta)
    const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
    const prevTo = (() => { const d = new Date(from); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
    const prevFrom = (() => { const d = new Date(prevTo); d.setDate(d.getDate() - (days - 1)); return d.toISOString().slice(0, 10); })();

    const [cur, prev, daily] = await Promise.all([
      this.overview({ from, to }),
      this.overview({ from: prevFrom, to: prevTo }),
      this.dailySeries(from, to),
    ]);

    const pct = (c: number, p: number) => (p > 0 ? +(((c - p) / p) * 100).toFixed(1) : 0);
    const dayList = this.isoDays(from, to);
    const seriesOf = (key: 'count' | 'revenue' | 'cost' | 'margin') =>
      dayList.map((d) => daily.get(d)?.[key] ?? 0);

    return {
      range: { from, to },
      currency: 'MXN',
      shipments: { value: cur.shipments.count, delta_pct: pct(cur.shipments.count, prev.shipments.count), series: seriesOf('count') },
      revenue:   { value: cur.revenue.freight, delta_pct: pct(cur.revenue.freight, prev.revenue.freight), series: seriesOf('revenue') },
      cost:      { value: cur.cost.total, delta_pct: pct(cur.cost.total, prev.cost.total), series: seriesOf('cost') },
      margin:    { value: cur.margin.gross, delta_pct: pct(cur.margin.gross, prev.margin.gross), pct: cur.margin.gross_pct, series: seriesOf('margin') },
    };
  }

  /** Serie diaria realizada (count/revenue/cost/margin por día) en un Map por fecha ISO. */
  private async dailySeries(from: string, to: string) {
    return this.tk.run(async (trx) => {
      const ships = await trx('logistics.shipments as s')
        .whereNull('s.deleted_at')
        .whereIn('s.status', REALIZED_STATUSES)
        .where('s.shipment_date', '>=', from)
        .where('s.shipment_date', '<=', to)
        .groupByRaw('s.shipment_date::date')
        .select([
          trx.raw('s.shipment_date::date AS d'),
          trx.raw('COUNT(*)::int AS count'),
          trx.raw('COALESCE(SUM(s.freight_revenue),0)::numeric AS revenue'),
        ]);

      const costs = await trx('logistics.shipment_expenses as e')
        .join('logistics.shipments as s', 's.id', 'e.shipment_id')
        .whereNull('s.deleted_at')
        .whereIn('s.status', REALIZED_STATUSES)
        .where('s.shipment_date', '>=', from)
        .where('s.shipment_date', '<=', to)
        .groupByRaw('s.shipment_date::date')
        .select([
          trx.raw('s.shipment_date::date AS d'),
          trx.raw('COALESCE(SUM(e.total_cost),0)::numeric AS cost'),
        ]);

      const map = new Map<string, { count: number; revenue: number; cost: number; margin: number }>();
      const key = (d: any) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
      for (const r of ships) map.set(key(r.d), { count: Number(r.count), revenue: Number(r.revenue), cost: 0, margin: Number(r.revenue) });
      for (const r of costs) {
        const k = key(r.d);
        const e = map.get(k) || { count: 0, revenue: 0, cost: 0, margin: 0 };
        e.cost = Number(r.cost);
        e.margin = e.revenue - e.cost;
        map.set(k, e);
      }
      return map;
    });
  }

  private isoDays(from: string, to: string): string[] {
    const out: string[] = [];
    const cur = new Date(from);
    const end = new Date(to);
    let guard = 0;
    while (cur <= end && guard++ < 400) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }

  // ── Shipment profitability list ──────────────────────────────────────────

  /**
   * Lista de embarques realizados con su rentabilidad individual.
   * Ordenada por margen desc (más rentables primero).
   */
  async shipmentProfitability(q: ProfitabilityQuery) {
    const limit = Math.min(500, Math.max(1, q.limit || 50));
    return this.tk.run(async (trx) => {
      let qry = trx('logistics.shipments as s')
        .leftJoin('logistics.shipment_expenses as e', 'e.shipment_id', 's.id')
        .leftJoin('logistics.vehicles as v', 'v.id', 's.vehicle_id')
        .leftJoin('logistics.routes as r', 'r.id', 's.route_id')
        .whereNull('s.deleted_at')
        .whereIn('s.status', REALIZED_STATUSES);

      if (q.from) qry = qry.where('s.shipment_date', '>=', q.from);
      if (q.to) qry = qry.where('s.shipment_date', '<=', q.to);
      if (q.vehicle_id) qry = qry.where('s.vehicle_id', q.vehicle_id);
      if (q.route_id) qry = qry.where('s.route_id', q.route_id);

      const rows = await qry.select([
        's.id', 's.folio', 's.shipment_date', 's.status',
        's.actual_km', 's.boxes_count',
        's.freight_revenue',
        trx.raw('COALESCE(e.total_cost, 0)::numeric AS cost'),
        trx.raw('COALESCE(e.fixed_cost_per_km, 0)::numeric AS fixed_cost_per_km'),
        'v.plate as vehicle_plate',
        'r.name as route_name',
      ]).limit(limit);

      return rows
        .map((r) => {
          const revenue = Number(r.freight_revenue);
          const cost = Number(r.cost);
          const margin = revenue - cost;
          return {
            id: r.id,
            folio: r.folio,
            shipment_date: r.shipment_date,
            status: r.status,
            vehicle_plate: r.vehicle_plate,
            route_name: r.route_name,
            actual_km: r.actual_km,
            boxes_count: r.boxes_count,
            revenue: +revenue.toFixed(2),
            cost: +cost.toFixed(2),
            margin: +margin.toFixed(2),
            margin_pct: revenue > 0 ? +((margin / revenue) * 100).toFixed(2) : 0,
          };
        })
        .sort((a, b) => b.margin - a.margin);
    });
  }

  // ── Fleet utilization ────────────────────────────────────────────────────

  /**
   * Uso por vehículo en el rango: cuántos embarques, km totales, revenue + cost.
   * Útil para decidir reemplazo de unidades o reasignación.
   */
  async fleetUtilization(q: DateRangeQuery) {
    return this.tk.run(async (trx) => {
      let qry = trx('logistics.vehicles as v')
        .leftJoin('logistics.shipments as s', function (this: any) {
          this.on('s.vehicle_id', 'v.id').andOnNull('s.deleted_at');
        })
        .leftJoin('logistics.shipment_expenses as e', 'e.shipment_id', 's.id')
        .whereNull('v.deleted_at');

      // Filtros sobre shipments (mantiene vehicles aunque sin actividad en rango)
      const subq = trx('logistics.shipments')
        .whereNull('deleted_at')
        .whereIn('status', REALIZED_STATUSES);
      if (q.from) subq.where('shipment_date', '>=', q.from);
      if (q.to) subq.where('shipment_date', '<=', q.to);
      // Filtra solo shipments en rango via LEFT JOIN condition extra
      // (más simple: dejar el JOIN amplio y filtrar en agg)

      const rows = await qry.select([
        'v.id', 'v.plate', 'v.model', 'v.brand', 'v.status',
        trx.raw(
          `COALESCE(COUNT(s.id) FILTER (WHERE s.status IN ('entregado','cerrado')${q.from ? ` AND s.shipment_date >= '${q.from}'` : ''}${q.to ? ` AND s.shipment_date <= '${q.to}'` : ''}), 0)::int AS shipments_realized`,
        ),
        trx.raw(
          `COALESCE(SUM(s.actual_km) FILTER (WHERE s.status IN ('entregado','cerrado')${q.from ? ` AND s.shipment_date >= '${q.from}'` : ''}${q.to ? ` AND s.shipment_date <= '${q.to}'` : ''}), 0)::int AS total_km`,
        ),
        trx.raw(
          `COALESCE(SUM(s.freight_revenue) FILTER (WHERE s.status IN ('entregado','cerrado')${q.from ? ` AND s.shipment_date >= '${q.from}'` : ''}${q.to ? ` AND s.shipment_date <= '${q.to}'` : ''}), 0)::numeric AS total_revenue`,
        ),
        trx.raw(
          `COALESCE(SUM(e.total_cost) FILTER (WHERE s.status IN ('entregado','cerrado')${q.from ? ` AND s.shipment_date >= '${q.from}'` : ''}${q.to ? ` AND s.shipment_date <= '${q.to}'` : ''}), 0)::numeric AS total_cost`,
        ),
      ]).groupBy('v.id', 'v.plate', 'v.model', 'v.brand', 'v.status')
        .orderBy('total_revenue', 'desc');

      return rows.map((r) => {
        const revenue = Number(r.total_revenue);
        const cost = Number(r.total_cost);
        const margin = revenue - cost;
        return {
          vehicle_id: r.id,
          plate: r.plate,
          model: r.model,
          brand: r.brand,
          status: r.status,
          shipments_realized: Number(r.shipments_realized),
          total_km: Number(r.total_km),
          total_revenue: +revenue.toFixed(2),
          total_cost: +cost.toFixed(2),
          gross_margin: +margin.toFixed(2),
          margin_pct: revenue > 0 ? +((margin / revenue) * 100).toFixed(2) : 0,
        };
      });
    });
  }

  // ── Payroll totals ───────────────────────────────────────────────────────

  /**
   * Totales liquidados por período. Filtra por year opcional.
   * Cuenta solo liquidaciones NO anuladas.
   */
  /**
   * Pipeline operacional: pedidos confirmados o por aprobar que **todavía no
   * tienen un embarque programado o en ruta**, agrupados por ruta logística.
   * Es la cola "lista para embarcar" que el operador de logística debe atacar.
   *
   * Criterios:
   *   - `commercial.orders` en `confirmed` o `pending_approval` (stock reservado).
   *   - Sin shipment activo asociado (NOT EXISTS row en `logistics.shipments`
   *     que apunte a esa orden y no esté en estado `entregado`/`cerrado`/`cancelado`).
   */
  async pendingByRoute() {
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.orders as o')
        .leftJoin('logistics.routes as r', 'r.id', 'o.route_id')
        .whereIn('o.status', ['confirmed', 'pending_approval'])
        .whereNull('o.deleted_at')
        .whereNotExists(function (this: any) {
          this.select(trx.raw('1'))
            .from('logistics.shipments as sh')
            .whereRaw('sh.order_id = o.id')
            .whereNull('sh.deleted_at')
            .whereNotIn('sh.status', ['cancelado']);
        })
        .groupBy('o.route_id', 'r.name')
        .select([
          'o.route_id',
          trx.raw(`COALESCE(r.name, '— Sin ruta asignada —') as route_name`),
          trx.raw('COUNT(*)::int as orders_count'),
          trx.raw(`COUNT(*) FILTER (WHERE o.status = 'confirmed')::int as orders_confirmed`),
          trx.raw(`COUNT(*) FILTER (WHERE o.status = 'pending_approval')::int as orders_pending_approval`),
          trx.raw('COALESCE(SUM(o.total), 0)::numeric as total_value'),
          trx.raw('MIN(o.created_at) as oldest_order_at'),
        ])
        .orderBy([{ column: 'orders_count', order: 'desc' }, { column: 'route_name', order: 'asc' }]);

      return rows.map((r) => ({
        route_id: r.route_id,
        route_name: r.route_name,
        orders_count: Number(r.orders_count),
        orders_confirmed: Number(r.orders_confirmed),
        orders_pending_approval: Number(r.orders_pending_approval),
        total_value: +Number(r.total_value).toFixed(2),
        oldest_order_at: r.oldest_order_at,
      }));
    });
  }

  async payrollTotals(year?: number) {
    return this.tk.run(async (trx) => {
      let qry = trx('logistics.payroll_periods as p')
        .leftJoin('logistics.liquidations as l', function (this: any) {
          this.on('l.period_id', 'p.id').andOnVal('l.status', '!=', 'anulado');
        });

      if (year) qry = qry.where('p.year', year);

      const rows = await qry.select([
        'p.id', 'p.year', 'p.number', 'p.start_date', 'p.end_date', 'p.payment_date', 'p.status',
        trx.raw('COALESCE(COUNT(l.id), 0)::int AS liquidations_count'),
        trx.raw('COALESCE(SUM(l.commissions_amount), 0)::numeric AS total_commissions'),
        trx.raw('COALESCE(SUM(l.per_diem_amount), 0)::numeric AS total_per_diem'),
        trx.raw('COALESCE(SUM(l.load_unload_amount), 0)::numeric AS total_load_unload'),
        trx.raw('COALESCE(SUM(l.bonuses), 0)::numeric AS total_bonuses'),
        trx.raw('COALESCE(SUM(l.deductions), 0)::numeric AS total_deductions'),
        trx.raw('COALESCE(SUM(l.subtotal), 0)::numeric AS total_subtotal'),
        trx.raw('COALESCE(SUM(l.net_amount), 0)::numeric AS total_net'),
        trx.raw(`COALESCE(SUM(l.net_amount) FILTER (WHERE l.status = 'pagado'), 0)::numeric AS total_paid`),
      ]).groupBy('p.id', 'p.year', 'p.number', 'p.start_date', 'p.end_date', 'p.payment_date', 'p.status')
        .orderBy('p.year', 'desc').orderBy('p.number', 'desc');

      return rows.map((r) => ({
        period_id: r.id,
        period: `${r.year}/${r.number}`,
        year: Number(r.year),
        number: Number(r.number),
        start_date: r.start_date,
        end_date: r.end_date,
        payment_date: r.payment_date,
        status: r.status,
        liquidations_count: Number(r.liquidations_count),
        total_commissions: +Number(r.total_commissions).toFixed(2),
        total_per_diem: +Number(r.total_per_diem).toFixed(2),
        total_load_unload: +Number(r.total_load_unload).toFixed(2),
        total_bonuses: +Number(r.total_bonuses).toFixed(2),
        total_deductions: +Number(r.total_deductions).toFixed(2),
        total_subtotal: +Number(r.total_subtotal).toFixed(2),
        total_net: +Number(r.total_net).toFixed(2),
        total_paid: +Number(r.total_paid).toFixed(2),
      }));
    });
  }

  // ── J12.7 ROI / historia de ahorro ───────────────────────────────────────

  /**
   * Consolida la "historia del costo" del periodo: ingreso de flete, costo total
   * y desglose por categoría, costo/km, share de combustible, gasto de
   * mantenimiento y margen. Es el número presentable (lección Samsara "8X ROI").
   */
  async roiSummary(q: DateRangeQuery) {
    return this.tk.run(async (trx) => {
      let base = trx('logistics.shipments as s')
        .leftJoin('logistics.shipment_expenses as e', 'e.shipment_id', 's.id')
        .whereNull('s.deleted_at')
        .whereIn('s.status', REALIZED_STATUSES);
      if (q.from) base = base.where('s.shipment_date', '>=', q.from);
      if (q.to) base = base.where('s.shipment_date', '<=', q.to);

      const [row] = await base.select([
        trx.raw('COUNT(DISTINCT s.id)::int AS shipments'),
        trx.raw('COALESCE(SUM(s.freight_revenue),0)::numeric AS revenue'),
        trx.raw('COALESCE(SUM(s.actual_km),0)::int AS km'),
        trx.raw('COALESCE(SUM(e.total_cost),0)::numeric AS total_cost'),
        trx.raw('COALESCE(SUM(e.operating_subtotal),0)::numeric AS operating'),
        trx.raw('COALESCE(SUM(e.fuel),0)::numeric AS fuel'),
        trx.raw('COALESCE(SUM(e.tolls),0)::numeric AS tolls'),
        trx.raw('COALESCE(SUM(e.driver_per_diem),0)::numeric AS per_diem'),
        trx.raw('COALESCE(SUM(e.handling),0)::numeric AS handling'),
        trx.raw('COALESCE(SUM(e.repairs),0)::numeric AS repairs'),
        trx.raw('COALESCE(SUM(e.lodging + e.parking + e.permits + e.external_helpers + e.other),0)::numeric AS otros'),
      ]);

      let mq = trx('logistics.vehicle_maintenance').whereNull('deleted_at');
      if (q.from) mq = mq.where('service_date', '>=', q.from);
      if (q.to) mq = mq.where('service_date', '<=', q.to);
      const [{ maintenance_cost }] = await mq.select(trx.raw('COALESCE(SUM(cost),0)::numeric AS maintenance_cost'));

      // J12.7: km ahorrados por optimización de ruta en el período.
      let oq = trx('logistics.route_optimizations');
      if (q.from) oq = oq.whereRaw('created_at >= ?', [q.from]);
      if (q.to) oq = oq.whereRaw('created_at <= (?::date + 1)', [q.to]);
      const [{ km_saved }] = await oq.select(trx.raw('COALESCE(SUM(saved_km),0)::numeric AS km_saved'));

      const n = (v: any) => +Number(v).toFixed(2);
      const revenue = n(row.revenue);
      const totalCost = n(row.total_cost);
      const km = Number(row.km);
      const fuel = n(row.fuel);
      const operating = n(row.operating);
      const maint = n(maintenance_cost);
      const margin = n(revenue - totalCost);

      return {
        period: { from: q.from || null, to: q.to || null },
        currency: 'MXN',
        shipments: Number(row.shipments),
        km,
        revenue_freight: revenue,
        cost_total: totalCost,
        cost_per_km: km > 0 ? n(totalCost / km) : 0,
        margin,
        margin_pct: revenue > 0 ? n((margin / revenue) * 100) : 0,
        fuel_cost: fuel,
        fuel_pct_of_operating: operating > 0 ? n((fuel / operating) * 100) : 0,
        maintenance_cost: maint,
        km_saved_optimization: n(km_saved),
        cost_breakdown: {
          fuel,
          tolls: n(row.tolls),
          driver_per_diem: n(row.per_diem),
          handling: n(row.handling),
          repairs: n(row.repairs),
          otros: n(row.otros),
        },
      };
    });
  }
}
