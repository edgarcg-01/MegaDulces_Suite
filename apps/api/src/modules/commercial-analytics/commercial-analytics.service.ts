import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService } from '../../shared/database/tenant-knex.service';
import { TenantContextService } from '../../shared/tenant/tenant-context.service';

/**
 * Sales analytics agregado sobre `commercial.*`.
 *
 * Queries con tenant context activo (RLS filtra commercial.*). Solo cuenta
 * pedidos en estado 'fulfilled' para revenue real.
 *
 * Estrategia para C.1 (mv-first):
 *   - overview, top-customers, top-products → leen de `analytics.mv_*` (refresh
 *     cada 15 min via AnalyticsRefreshService). Param `?live=true` fuerza
 *     fallback a on-the-fly aggregation cuando se necesita data fresca.
 *   - inactive-customers, sales-by-brand, low-stock, daily-series → on-the-fly
 *     (no se beneficiarían de materialización porque cambian con cada read).
 *
 * NOTA RLS: las MVs no soportan RLS directo. El service filtra por
 * `tenant_id = current_tenant_id()` explícitamente en cada query de MVs.
 */

export interface DateRangeQuery {
  from?: string;
  to?: string;
}

const REVENUE_STATUSES = ['fulfilled'];
// Para "trabajo en curso" que cuenta como pipeline (no revenue): 'confirmed'

@Injectable()
export class CommercialAnalyticsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Overview rolling 30d desde MV (default) o on-the-fly si live=true o si hay
   * date range explícito (las MVs son siempre 30d).
   */
  async overview30dFromMv() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const row = await trx('analytics.mv_sales_overview_30d')
        .where({ tenant_id: tenantId })
        .first();

      if (!row) {
        // MV vacía o sin refresh aún para este tenant — devolver zeros.
        return this.emptyOverview('mv', null);
      }

      const revenue = Number(row.revenue_gross);
      const orders = Number(row.orders_fulfilled);

      return {
        source: 'mv',
        refreshed_at: row.refreshed_at,
        period: { rolling_days: 30 },
        revenue: {
          gross: revenue,
          net: Number(row.revenue_net),
          tax: Number(row.tax_collected),
          currency: 'MXN',
        },
        orders: {
          fulfilled: orders,
          confirmed: Number(row.orders_confirmed),
          draft: Number(row.orders_draft),
          cancelled: Number(row.orders_cancelled),
          avg_order_value: orders > 0 ? +(revenue / orders).toFixed(2) : 0,
        },
        unique_customers: Number(row.unique_customers),
      };
    });
  }

  /**
   * Overview general del período: pedidos, revenue, unidades, AOV, clientes únicos.
   * Si `q` viene vacío, prefiere leer de MV (mucho más rápido). Si hay date range
   * o `live=true`, agrega on-the-fly.
   */
  async overview(q: DateRangeQuery & { live?: boolean }) {
    const hasRange = !!(q.from || q.to);
    if (!hasRange && !q.live) {
      return this.overview30dFromMv();
    }
    return this.overviewLive(q);
  }

  private emptyOverview(source: 'mv' | 'live', period: any) {
    return {
      source,
      refreshed_at: null,
      period,
      revenue: { gross: 0, net: 0, tax: 0, currency: 'MXN' },
      orders: { fulfilled: 0, confirmed: 0, draft: 0, cancelled: 0, avg_order_value: 0 },
      units_sold: 0,
      unique_customers: 0,
    };
  }

  private async overviewLive(q: DateRangeQuery) {
    const { from, to } = this.parseDateRange(q);

    return this.tk.run(async (trx) => {
      const orders = trx('commercial.orders').whereNull('deleted_at');

      const fulfilled = orders.clone().whereIn('status', REVENUE_STATUSES);
      const confirmed = orders.clone().where('status', 'confirmed');
      const draft = orders.clone().where('status', 'draft');
      const cancelled = orders.clone().where('status', 'cancelled');

      if (from) {
        fulfilled.where('created_at', '>=', from);
        confirmed.where('created_at', '>=', from);
        draft.where('created_at', '>=', from);
        cancelled.where('created_at', '>=', from);
      }
      if (to) {
        fulfilled.where('created_at', '<=', to);
        confirmed.where('created_at', '<=', to);
        draft.where('created_at', '<=', to);
        cancelled.where('created_at', '<=', to);
      }

      const [fulfilledStats] = await fulfilled
        .clone()
        .select(
          trx.raw('COUNT(*)::int as orders_count'),
          trx.raw('COALESCE(SUM(total), 0)::numeric as revenue'),
          trx.raw('COALESCE(SUM(subtotal), 0)::numeric as net_revenue'),
          trx.raw('COALESCE(SUM(tax_total), 0)::numeric as tax_collected'),
          trx.raw('COUNT(DISTINCT customer_id)::int as unique_customers'),
        );

      const [unitsRow] = await trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .whereIn('o.status', REVENUE_STATUSES)
        .modify((qb) => {
          if (from) qb.where('o.created_at', '>=', from);
          if (to) qb.where('o.created_at', '<=', to);
        })
        .select(trx.raw('COALESCE(SUM(ol.quantity), 0)::numeric as units_sold'));

      const [confirmedCount] = await confirmed.clone().count<{ count: string }[]>('* as count');
      const [draftCount] = await draft.clone().count<{ count: string }[]>('* as count');
      const [cancelledCount] = await cancelled.clone().count<{ count: string }[]>('* as count');

      const revenue = Number(fulfilledStats.revenue);
      const ordersCount = Number(fulfilledStats.orders_count);

      return {
        source: 'live',
        period: { from: from || null, to: to || null },
        revenue: {
          gross: revenue,
          net: Number(fulfilledStats.net_revenue),
          tax: Number(fulfilledStats.tax_collected),
          currency: 'MXN',
        },
        orders: {
          fulfilled: ordersCount,
          confirmed: Number(confirmedCount.count),
          draft: Number(draftCount.count),
          cancelled: Number(cancelledCount.count),
          avg_order_value: ordersCount > 0 ? +(revenue / ordersCount).toFixed(2) : 0,
        },
        units_sold: Number(unitsRow.units_sold),
        unique_customers: Number(fulfilledStats.unique_customers),
      };
    });
  }

  /**
   * Top N customers por revenue. Sin date range → MV (rolling 30d).
   * Con date range o live=true → on-the-fly.
   */
  async topCustomers(q: DateRangeQuery & { limit?: number; live?: boolean }) {
    const hasRange = !!(q.from || q.to);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 10));

    if (!hasRange && !q.live) {
      const tenantId = this.tenantCtx.requireTenantId();
      return this.tk.run(async (trx) => {
        const rows = await trx('analytics.mv_top_customers_30d')
          .where({ tenant_id: tenantId })
          .orderBy('rank', 'asc')
          .limit(limit);
        return rows.map((r: any) => ({
          source: 'mv',
          customer_id: r.customer_id,
          code: r.code,
          name: r.name,
          orders_count: Number(r.orders_count),
          revenue: Number(r.revenue),
          avg_order_value: Number(r.avg_order_value),
          last_order_at: r.last_order_at,
          rank: Number(r.rank),
        }));
      });
    }
    return this.topCustomersLive({ ...q, limit });
  }

  private async topCustomersLive(q: DateRangeQuery & { limit: number }) {
    const { from, to } = this.parseDateRange(q);
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.orders as o')
        .join('commercial.customers as c', 'c.id', 'o.customer_id')
        .whereNull('o.deleted_at')
        .whereIn('o.status', REVENUE_STATUSES)
        .modify((qb) => {
          if (from) qb.where('o.created_at', '>=', from);
          if (to) qb.where('o.created_at', '<=', to);
        })
        .select(
          'c.id as customer_id',
          'c.code',
          'c.name',
          trx.raw('COUNT(o.id)::int as orders_count'),
          trx.raw('COALESCE(SUM(o.total), 0)::numeric as revenue'),
          trx.raw('COALESCE(AVG(o.total), 0)::numeric as avg_order_value'),
          trx.raw('MAX(o.created_at) as last_order_at'),
        )
        .groupBy('c.id', 'c.code', 'c.name')
        .orderBy('revenue', 'desc')
        .limit(q.limit);

      return rows.map((r) => ({
        source: 'live',
        ...r,
        revenue: Number(r.revenue),
        avg_order_value: Number(r.avg_order_value),
      }));
    });
  }

  /**
   * Top N productos por unidades o revenue. Sin date range → MV (rolling 30d).
   * Con date range o live=true → on-the-fly.
   */
  async topProducts(
    q: DateRangeQuery & { limit?: number; orderBy?: 'units' | 'revenue'; live?: boolean },
  ) {
    const hasRange = !!(q.from || q.to);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 10));
    const orderBy = q.orderBy === 'revenue' ? 'revenue' : 'units';

    if (!hasRange && !q.live) {
      const tenantId = this.tenantCtx.requireTenantId();
      return this.tk.run(async (trx) => {
        const rankCol = orderBy === 'revenue' ? 'rank_by_revenue' : 'rank_by_units';
        const rows = await trx('analytics.mv_top_products_30d')
          .where({ tenant_id: tenantId })
          .orderBy(rankCol, 'asc')
          .limit(limit);
        return rows.map((r: any) => ({
          source: 'mv',
          product_id: r.product_id,
          product_name: r.product_name,
          brand_name: r.brand_name,
          units_sold: Number(r.units_sold),
          revenue: Number(r.revenue),
          orders_count: Number(r.orders_count),
          rank_by_units: Number(r.rank_by_units),
          rank_by_revenue: Number(r.rank_by_revenue),
        }));
      });
    }
    return this.topProductsLive({ ...q, limit, orderBy });
  }

  private async topProductsLive(q: DateRangeQuery & { limit: number; orderBy: string }) {
    const { from, to } = this.parseDateRange(q);
    const orderByCol = q.orderBy === 'revenue' ? 'revenue' : 'units_sold';

    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .leftJoin('public.products as p', 'p.id', 'ol.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .whereNull('o.deleted_at')
        .whereIn('o.status', REVENUE_STATUSES)
        .modify((qb) => {
          if (from) qb.where('o.created_at', '>=', from);
          if (to) qb.where('o.created_at', '<=', to);
        })
        .select(
          'p.id as product_id',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          trx.raw('COALESCE(SUM(ol.quantity), 0)::numeric as units_sold'),
          trx.raw('COALESCE(SUM(ol.line_total), 0)::numeric as revenue'),
          trx.raw('COUNT(DISTINCT o.id)::int as orders_count'),
        )
        .groupBy('p.id', 'p.nombre', 'b.nombre')
        .orderBy(orderByCol, 'desc')
        .limit(q.limit);

      return rows.map((r) => ({
        source: 'live',
        ...r,
        units_sold: Number(r.units_sold),
        revenue: Number(r.revenue),
      }));
    });
  }

  /**
   * Customers sin pedidos en los últimos N días (oportunidad de recuperación).
   */
  async inactiveCustomers(daysParam?: string | number, limitParam?: string | number) {
    const days = Math.max(1, Math.min(365, Number(daysParam) || 30));
    const limit = Math.min(200, Math.max(1, Number(limitParam) || 50));

    return this.tk.run(async (trx) => {
      // Customers activos sin pedido fulfilled o confirmed en los últimos N días
      const rows = await trx
        .select(
          'c.id as customer_id',
          'c.code',
          'c.name',
          'c.phone',
          'c.credit_limit',
          trx.raw('MAX(o.created_at) as last_order_at'),
          trx.raw(`
            CASE WHEN MAX(o.created_at) IS NULL
              THEN NULL
              ELSE EXTRACT(DAY FROM (NOW() - MAX(o.created_at)))::int
            END as days_since_last_order
          `),
        )
        .from('commercial.customers as c')
        .leftJoin('commercial.orders as o', function () {
          this.on('o.customer_id', '=', 'c.id').andOnIn('o.status', ['confirmed', 'fulfilled']);
        })
        .where('c.active', true)
        .whereNull('c.deleted_at')
        .groupBy('c.id', 'c.code', 'c.name', 'c.phone', 'c.credit_limit')
        .havingRaw(
          `MAX(o.created_at) IS NULL OR MAX(o.created_at) < NOW() - INTERVAL '${days} days'`,
        )
        .orderByRaw('MAX(o.created_at) ASC NULLS FIRST')
        .limit(limit);

      return {
        threshold_days: days,
        customers: rows.map((r) => ({
          ...r,
          credit_limit: Number(r.credit_limit),
        })),
      };
    });
  }

  /**
   * Revenue/units por brand en el período + share % del total.
   */
  async salesByBrand(q: DateRangeQuery) {
    const { from, to } = this.parseDateRange(q);

    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .leftJoin('public.products as p', 'p.id', 'ol.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .whereNull('o.deleted_at')
        .whereIn('o.status', REVENUE_STATUSES)
        .modify((qb) => {
          if (from) qb.where('o.created_at', '>=', from);
          if (to) qb.where('o.created_at', '<=', to);
        })
        .select(
          'b.id as brand_id',
          'b.nombre as brand_name',
          trx.raw('COALESCE(SUM(ol.quantity), 0)::numeric as units'),
          trx.raw('COALESCE(SUM(ol.line_total), 0)::numeric as revenue'),
        )
        .groupBy('b.id', 'b.nombre')
        .orderBy('revenue', 'desc');

      const totalRevenue = rows.reduce((s, r) => s + Number(r.revenue), 0);

      return rows.map((r) => ({
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        units: Number(r.units),
        revenue: Number(r.revenue),
        share_pct: totalRevenue > 0 ? +((Number(r.revenue) / totalRevenue) * 100).toFixed(2) : 0,
      }));
    });
  }

  /**
   * Productos con stock disponible (quantity - reserved) bajo threshold.
   * Útil para alertas de reposición.
   */
  async lowStock(thresholdParam?: string | number, warehouseIdParam?: string) {
    const threshold = Math.max(0, Number(thresholdParam) || 10);

    return this.tk.run(async (trx) => {
      const q = trx('commercial.stock as s')
        .leftJoin('commercial.warehouses as w', 'w.id', 's.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 's.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .whereRaw('(s.quantity - s.reserved_quantity) < ?', [threshold]);

      if (warehouseIdParam) q.where('s.warehouse_id', warehouseIdParam);

      const rows = await q
        .select(
          's.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          's.product_id',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          's.quantity',
          's.reserved_quantity',
          trx.raw('(s.quantity - s.reserved_quantity) as available_quantity'),
        )
        .orderByRaw('(s.quantity - s.reserved_quantity) ASC');

      return {
        threshold,
        warehouse_id: warehouseIdParam || null,
        items: rows.map((r) => ({
          ...r,
          quantity: Number(r.quantity),
          reserved_quantity: Number(r.reserved_quantity),
          available_quantity: Number(r.available_quantity),
        })),
      };
    });
  }

  /**
   * Series diarias de revenue + orders count para gráficos. Solo fulfilled.
   */
  async dailySeries(q: DateRangeQuery) {
    const { from, to } = this.parseDateRange(q);

    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.orders')
        .whereNull('deleted_at')
        .whereIn('status', REVENUE_STATUSES)
        .modify((qb) => {
          if (from) qb.where('created_at', '>=', from);
          if (to) qb.where('created_at', '<=', to);
        })
        .select(
          trx.raw(`DATE_TRUNC('day', created_at AT TIME ZONE 'America/Mexico_City')::date as day`),
          trx.raw('COUNT(*)::int as orders_count'),
          trx.raw('COALESCE(SUM(total), 0)::numeric as revenue'),
          trx.raw('COALESCE(SUM(subtotal), 0)::numeric as net_revenue'),
        )
        .groupByRaw(`DATE_TRUNC('day', created_at AT TIME ZONE 'America/Mexico_City')`)
        .orderBy('day', 'asc');

      return rows.map((r) => ({
        day: r.day,
        orders_count: Number(r.orders_count),
        revenue: Number(r.revenue),
        net_revenue: Number(r.net_revenue),
      }));
    });
  }

  // ─────────── Sprint M.3 — Ventas históricas (ERP Mega_Dulces vía FDW) ───────────

  /**
   * Series diarias desde `analytics_external.ventas_legacy` (foreign table sobre
   * `Mega_Dulces.public.ventas` en .245). Datos transaccionales desnormalizados,
   * NO pasan por commercial.orders. Sirve para reportería de ventas reales del
   * ERP (no de pedidos B2B levantados por la app).
   *
   * Pushdown FDW: WHERE fecha/zona se aplica remotamente. Para período corto
   * (<30d) el GROUP BY también baja, así que aunque la tabla source tenga 2.1M
   * rows, el plan solo transfiere el resultado agregado (decenas de filas).
   */
  async historicalSalesDaily(q: { from?: string; to?: string; zona?: string }) {
    const { from, to } = this.parseDateRange(q);
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics_external.ventas_legacy')
        .modify((qb) => {
          if (from) qb.where('fecha', '>=', from);
          if (to) qb.where('fecha', '<=', to);
          if (q.zona) qb.where('zona', q.zona);
        })
        .select(
          'fecha AS day',
          trx.raw('COUNT(*)::int AS lines'),
          trx.raw('COALESCE(SUM(cantidad), 0)::numeric AS units'),
          trx.raw('COALESCE(SUM(venta_diaria), 0)::numeric AS revenue'),
          trx.raw('COALESCE(SUM(costo), 0)::numeric AS cost'),
        )
        .groupBy('fecha')
        .orderBy('fecha', 'asc');
      return rows.map((r) => ({
        day: r.day,
        lines: Number(r.lines),
        units: Number(r.units),
        revenue: Number(r.revenue),
        cost: Number(r.cost),
        margin: Number(r.revenue) - Number(r.cost),
      }));
    });
  }

  /** Top productos del ERP por revenue en el período. */
  async historicalTopProducts(q: { from?: string; to?: string; zona?: string; limit?: number }) {
    const { from, to } = this.parseDateRange(q);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics_external.ventas_legacy')
        .modify((qb) => {
          if (from) qb.where('fecha', '>=', from);
          if (to) qb.where('fecha', '<=', to);
          if (q.zona) qb.where('zona', q.zona);
        })
        .select(
          'producto_id',
          'producto',
          'categoria',
          'subfamilia',
          trx.raw('COALESCE(SUM(cantidad), 0)::numeric AS units'),
          trx.raw('COALESCE(SUM(venta_diaria), 0)::numeric AS revenue'),
        )
        .groupBy('producto_id', 'producto', 'categoria', 'subfamilia')
        .orderBy('revenue', 'desc')
        .limit(limit);
      return rows.map((r) => ({
        producto_id: r.producto_id,
        producto: r.producto,
        categoria: r.categoria,
        subfamilia: r.subfamilia,
        units: Number(r.units),
        revenue: Number(r.revenue),
      }));
    });
  }

  /**
   * Top N productos pre-calculado por el ERP (Mega_Dulces.ranking_productos).
   * Esta tabla mantiene un top 1000 calculado por el ERP que cuenta TODA la
   * venta (no solo lo levantado por el portal/vendor app), por eso es más
   * fiel que el ranking derivado de `commercial.orders`.
   *
   * No acepta filtros — el ERP precalcula con su propia ventana temporal.
   */
  async historicalRanking(q: { limit?: number }) {
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics_external.ranking_legacy')
        .orderBy('posicion', 'asc')
        .limit(limit);
      return rows.map((r) => ({
        posicion: Number(r.posicion),
        articulo: r.articulo,
        nombre: r.nombre,
        total_cajas: Number(r.total_cajas || 0),
        total_piezas: Number(r.total_piezas || 0),
        total_piezas_totales: Number(r.total_piezas_totales || 0),
        total_venta: Number(r.total_venta || 0),
      }));
    });
  }

  /**
   * Margen por categoría sobre ventas del período.
   *
   * `ventas.categoria` deja de poblarse en el ERP desde mayo 2026, así que
   * JOIN-eamos por sku=articulo a `public.products` → `public.categories.name`
   * para obtener categoría estable. Costo usa `ventas.costo` cuando viene
   * (histórico al momento de venta), fallback a `cantidad × products.cost_base`
   * (costo actual).
   */
  async historicalMarginByCategory(q: { from?: string; to?: string; limit?: number }) {
    const { from, to } = this.parseDateRange(q);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();
      const rows = await trx.raw(
        `
        SELECT
          COALESCE(cat.name, 'Sin categoría')                AS category,
          cat.id                                              AS category_id,
          COUNT(DISTINCT v.producto_id)::int                  AS products,
          COUNT(*)::int                                       AS lines,
          COALESCE(SUM(v.cantidad), 0)::numeric               AS units,
          COALESCE(SUM(v.venta_diaria), 0)::numeric           AS revenue,
          COALESCE(SUM(
            COALESCE(v.costo, v.cantidad * COALESCE(p.cost_base, 0))
          ), 0)::numeric                                       AS cost,
          COALESCE(SUM(v.venta_diaria), 0)::numeric
            - COALESCE(SUM(
                COALESCE(v.costo, v.cantidad * COALESCE(p.cost_base, 0))
              ), 0)::numeric                                   AS margin,
          CASE WHEN SUM(v.venta_diaria) > 0
            THEN ROUND(
              ((SUM(v.venta_diaria) - COALESCE(SUM(
                  COALESCE(v.costo, v.cantidad * COALESCE(p.cost_base, 0))
                ), 0)) / SUM(v.venta_diaria)) * 100,
              2
            )
            ELSE NULL
          END                                                  AS margin_pct
        FROM analytics_external.ventas_legacy v
        LEFT JOIN public.products p
          ON p.sku = v.producto_id AND p.tenant_id = ?
        LEFT JOIN public.categories cat
          ON cat.id = p.category_id AND cat.tenant_id = ?
        WHERE 1=1
          ${from ? `AND v.fecha >= ?` : ''}
          ${to ? `AND v.fecha <= ?` : ''}
        GROUP BY cat.id, cat.name
        ORDER BY revenue DESC
        LIMIT ?
        `,
        [
          tenantId,
          tenantId,
          ...(from ? [from] : []),
          ...(to ? [to] : []),
          limit,
        ],
      );
      return rows.rows.map((r: any) => ({
        category: r.category,
        category_id: r.category_id,
        products: Number(r.products),
        lines: Number(r.lines),
        units: Number(r.units),
        revenue: Number(r.revenue),
        cost: Number(r.cost),
        margin: Number(r.margin),
        margin_pct: r.margin_pct != null ? Number(r.margin_pct) : null,
      }));
    });
  }

  /**
   * Productos en el top del ERP pero con stock=0 en commercial.stock.
   * Señal crítica: el ERP los considera best-sellers pero la app no tiene
   * dónde surtirlos → oportunidad de venta perdida.
   *
   * Match por SKU = articulo del ERP.
   */
  async rankingOutOfStock(q: { limit?: number; topN?: number }) {
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    // Solo escaneamos el top-N del ERP (más relevante; el ERP ya ordenó).
    const topN = Math.min(1000, Math.max(50, Number(q.topN) || 200));

    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();
      const rows = await trx.raw(
        `
        WITH top_erp AS (
          SELECT articulo, nombre, posicion, total_venta, total_piezas_totales
            FROM analytics_external.ranking_legacy
           ORDER BY posicion ASC
           LIMIT ?
        ),
        stock_agg AS (
          SELECT p.sku,
                 p.id AS product_id,
                 SUM(s.quantity)::numeric AS total_qty,
                 SUM(s.reserved_quantity)::numeric AS total_reserved
            FROM public.products p
            LEFT JOIN commercial.stock s ON s.product_id = p.id
           WHERE p.tenant_id = ?
             AND p.deleted_at IS NULL
             AND p.sku IS NOT NULL
           GROUP BY p.sku, p.id
        )
        SELECT t.posicion,
               t.articulo,
               t.nombre AS erp_name,
               t.total_venta,
               t.total_piezas_totales,
               sa.product_id,
               COALESCE(sa.total_qty, 0)::numeric AS total_qty,
               COALESCE(sa.total_reserved, 0)::numeric AS total_reserved,
               GREATEST(COALESCE(sa.total_qty, 0) - COALESCE(sa.total_reserved, 0), 0)::numeric AS available
          FROM top_erp t
          LEFT JOIN stock_agg sa ON sa.sku = t.articulo
         WHERE COALESCE(sa.total_qty, 0) - COALESCE(sa.total_reserved, 0) <= 0
         ORDER BY t.posicion ASC
         LIMIT ?
        `,
        [topN, tenantId, limit],
      );

      return rows.rows.map((r: any) => ({
        posicion: Number(r.posicion),
        articulo: r.articulo,
        product_id: r.product_id || null,
        nombre: r.erp_name,
        total_venta: Number(r.total_venta || 0),
        total_piezas_totales: Number(r.total_piezas_totales || 0),
        total_qty: Number(r.total_qty),
        total_reserved: Number(r.total_reserved),
        available: Number(r.available),
      }));
    });
  }

  /** Resumen por zona/sucursal en el período. */
  async historicalSalesByZona(q: { from?: string; to?: string }) {
    const { from, to } = this.parseDateRange(q);
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics_external.ventas_legacy')
        .modify((qb) => {
          if (from) qb.where('fecha', '>=', from);
          if (to) qb.where('fecha', '<=', to);
        })
        .select(
          'zona',
          'almacen',
          trx.raw('COUNT(DISTINCT folio)::int AS tickets'),
          trx.raw('COUNT(DISTINCT tercero_id)::int AS unique_customers'),
          trx.raw('COALESCE(SUM(cantidad), 0)::numeric AS units'),
          trx.raw('COALESCE(SUM(venta_diaria), 0)::numeric AS revenue'),
        )
        .groupBy('zona', 'almacen')
        .orderBy('revenue', 'desc');
      return rows.map((r) => ({
        zona: r.zona,
        almacen: r.almacen,
        tickets: Number(r.tickets),
        unique_customers: Number(r.unique_customers),
        units: Number(r.units),
        revenue: Number(r.revenue),
      }));
    });
  }

  // ─────────── helpers ───────────

  private parseDateRange(q: DateRangeQuery): { from?: string; to?: string } {
    const out: { from?: string; to?: string } = {};
    if (q.from) {
      if (!this.isIsoDate(q.from))
        throw new BadRequestException('from inválido (esperado ISO 8601)');
      out.from = q.from;
    }
    if (q.to) {
      if (!this.isIsoDate(q.to))
        throw new BadRequestException('to inválido (esperado ISO 8601)');
      out.to = q.to;
    }
    return out;
  }

  private isIsoDate(s: string): boolean {
    return !Number.isNaN(Date.parse(s));
  }
}
