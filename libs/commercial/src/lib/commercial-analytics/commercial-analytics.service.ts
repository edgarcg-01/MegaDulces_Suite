import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

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

// ── Fase RS — Sell-Out ──
export type SellOutGroupBy = 'branch' | 'branch_channel';

export interface SellOutQuery {
  brand_id: string;
  from: string;
  to: string;
  group_by?: SellOutGroupBy;
  channels?: string[];
  /** Códigos de almacén (commercial.warehouses.code) a incluir. Vacío = todos. */
  warehouses?: string[];
  include_zeros?: boolean;
}

export interface SellOutWarehouseRow {
  code: string;
  name: string;
}

// ── Fase SAL — Salidas/Ventas por Producto ──
export interface SalidasQuery {
  year?: number;
  // Modo rango (SAL.5): si vienen from/to (ISO), el reporte usa venta DIARIA
  // (analytics.product_sales_daily) y colapsa a una Venta/Costo del período.
  from?: string;
  to?: string;
  warehouses?: string[];
  brand_id?: string;
  supplier_id?: string;
  search?: string;
}

export interface SalidasRow {
  warehouse_code: string;
  warehouse_name: string;
  product_id: string;
  sku: string;
  nombre: string;
  uxc: number | null;
  supplier: string | null;
  brand: string | null;
  categoria: string | null;      // SAL.6 clasificación
  rotation_tier: string | null;  // SAL.6 ABC/rotación (baja|media|alta)
  costo_civa: number | null;
  costo_caja: number | null;
  exist_paq: number;
  exist_cja: number;
  costo_existencia: number;
  monthly: Record<string, { venta: number; costo: number }>;
  venta_total: number;
  costo_total: number;
  venta_cajas: number;             // SAL.6 venta_total ÷ UXC
  dias_cobertura: number | null;   // SAL.6 existencia ÷ venta diaria del período
  venta_prev: number | null;       // SAL.6 tendencia — venta período anterior (solo rango)
  venta_delta_pct: number | null;  // SAL.6 % variación vs período anterior
}

export interface SalidasReport {
  mode: 'year' | 'range';
  year?: number;
  from?: string;
  to?: string;
  dias_periodo: number;   // SAL.6 días del período (para cobertura + tendencia)
  has_trend: boolean;     // SAL.6 si venta_prev fue calculado (modo rango)
  months: string[];
  rows: SalidasRow[];
  generated_at: string;
}

// ── Fase RR — Ventas por Ruta ──
export interface SalesByRouteQuery {
  year: number;
  warehouses?: string[];
}

export interface SalesByRouteCell {
  revenue: number;
  units: number;
  tickets: number;
}

export interface SalesByRouteRow {
  warehouse_code: string;
  warehouse_name: string;
  route_code: string;
  route_no: string;
  label: string;
  monthly: Record<string, SalesByRouteCell>;
  revenue_total: number;
  units_total: number;
  tickets_total: number;
  share_pct: number;
}

export interface SalesByRouteReport {
  year: number;
  months: string[];
  rows: SalesByRouteRow[];
  totals: SalesByRouteCell;
  monthly_totals: Record<string, SalesByRouteCell>;
  generated_at: string;
}

// ── Fase T — Traspasos / movimientos que NO son venta ──
export type TransferKind = 'consolidacion' | 'recepcion' | 'traspaso_salida' | 'traspaso_entrada';

export interface TransfersQuery {
  year: number;
  warehouses?: string[];
}

export interface TransfersCell {
  value: number;
  units: number;
  docs: number;
}

export interface TransfersRow {
  warehouse_code: string;
  warehouse_name: string;
  kind: TransferKind;
  kind_label: string;
  monthly: Record<string, TransfersCell>;
  value_total: number;
  units_total: number;
  docs_total: number;
  share_pct: number;
}

export interface TransfersReport {
  year: number;
  months: string[];
  rows: TransfersRow[];
  totals: TransfersCell;
  monthly_totals: Record<string, TransfersCell>;
  by_kind: { kind: TransferKind; kind_label: string; value: number; share_pct: number }[];
  generated_at: string;
}

export interface SellOutColumn {
  key: string;
  branch_code: string;
  branch_name: string;
  channel?: string;
  channel_label?: string;
}

export interface SellOutCell {
  cajas: number;
  monto: number;
}

export interface SellOutRow {
  product_id: string;
  sku: string;
  nombre: string;
  uxc: number | null;
  cells: Record<string, SellOutCell>;
  total: SellOutCell;
}

export interface SellOutReport {
  brand: { id: string; nombre: string; code: string | null };
  period: { from: string; to: string };
  group_by: SellOutGroupBy;
  columns: SellOutColumn[];
  rows: SellOutRow[];
  column_totals: Record<string, SellOutCell>;
  grand_total: SellOutCell;
  coverage: { branches_with_data: string[]; branches_missing: string[]; note: string };
  generated_at: string;
}

export interface SellOutBrandRow {
  id: string;
  nombre: string;
  code: string | null;
  products: number;
}

const RS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNEL_LABELS: Record<string, string> = {
  mostrador: 'Mostrador',
  ruta: 'Ruta',
  credito: 'Crédito',
  otro: 'Otro',
};
const CHANNEL_ORDER: Record<string, number> = {
  mostrador: 0,
  ruta: 1,
  credito: 2,
  otro: 3,
};
// `TI*` = traspaso interno entre sucursales (logística, sale de CEDIS). NO es
// venta a cliente → se excluye del sell-out (contarlo duplica + infla).
const NON_SALE_CHANNEL = 'traspaso';

const REVENUE_STATUSES = ['fulfilled'];
// Para "trabajo en curso" que cuenta como pipeline (no revenue): 'confirmed'

@Injectable()
export class CommercialAnalyticsService {
  private readonly logger = new Logger(CommercialAnalyticsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Las queries `analytics_external.*` leen el ERP vía FDW (server
   * `mega_dulces_srv` en la LAN 192.168.0.245). Ese host NO es alcanzable desde
   * Railway, así que en prod el FDW da timeout (08001 / "could not connect to
   * server"). En vez de tirar un 500, degradamos: logueamos y devolvemos el
   * fallback (típicamente `[]`) para que la UI muestre estado vacío.
   */
  private isErpUnavailable(err: any): boolean {
    const code = String(err?.code || '');
    // 08*=conexión, 57P01=admin shutdown, 57014=statement_timeout (FDW colgado),
    // 55000=MV ERP sin popular todavía. Todos → data del ERP no disponible → fallback.
    if (['08001', '08006', '08004', '08003', '57P01', '57014', '55000'].includes(code)) return true;
    const msg = String(err?.message || err?.detail || '').toLowerCase();
    return (
      msg.includes('mega_dulces_srv') ||
      msg.includes('could not connect to server') ||
      msg.includes('connection timed out') ||
      msg.includes('has not been populated')
    );
  }

  private async guardErp<T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (this.isErpUnavailable(err)) {
        this.logger.warn(
          `ERP (FDW mega_dulces_srv) no disponible en ${label}: ${err?.code || ''} ${err?.message || err}`,
        );
        return fallback;
      }
      throw err;
    }
  }

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
   * Stock muerto: existencia > 0 pero sin venta reciente (rotación). Capital
   * parado al costo. Accionable para el comprador (qué liquidar / dejar de surtir).
   * "Muerto" = sales_units_30d = 0; rotation_tier null/baja matiza la severidad.
   */
  async deadStock(warehouseIdParam?: string, limitParam?: string | number) {
    const limit = Math.min(2000, Math.max(1, Number(limitParam) || 500));
    return this.tk.run(async (trx) => {
      // catalog.products (tabla real) — la vista public.products no expone
      // sales_units_30d/rotation_tier (columnas nuevas).
      const base = trx('commercial.stock as s')
        .leftJoin('commercial.warehouses as w', 'w.id', 's.warehouse_id')
        .leftJoin('catalog.products as p', 'p.id', 's.product_id')
        .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
        .where('s.quantity', '>', 0)
        // Ventana 90d (no 30d, que flaggea estacionales). = 0 estricto: NULL =
        // rotación no computada (desconocida), no "muerto".
        .where('p.sales_units_90d', 0);
      if (warehouseIdParam) base.where('s.warehouse_id', warehouseIdParam);

      const items = await base.clone()
        .select(
          's.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          's.product_id',
          'p.sku',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          'p.rotation_tier',
          'p.unit_sale',
          's.quantity',
          'p.cost_base',
          trx.raw('ROUND((s.quantity * COALESCE(p.cost_base,0))::numeric, 2) AS capital_parado'),
        )
        .orderByRaw('(s.quantity * COALESCE(p.cost_base,0)) DESC')
        .limit(limit);

      const byWh = await base.clone()
        .groupBy('s.warehouse_id', 'w.code', 'w.name')
        .select(
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          trx.raw('COUNT(*)::int AS skus'),
          trx.raw('ROUND(SUM(s.quantity * COALESCE(p.cost_base,0))::numeric, 2) AS capital_parado'),
        )
        .orderByRaw('SUM(s.quantity * COALESCE(p.cost_base,0)) DESC');

      const totalCapital = byWh.reduce((acc: number, r: any) => acc + Number(r.capital_parado || 0), 0);
      return {
        warehouse_id: warehouseIdParam || null,
        total_skus: items.length,
        total_capital_parado: +totalCapital.toFixed(2),
        by_warehouse: byWh,
        items: items.map((r: any) => ({
          ...r,
          quantity: Number(r.quantity),
          cost_base: Number(r.cost_base) || 0,
          capital_parado: Number(r.capital_parado) || 0,
        })),
      };
    });
  }

  /**
   * Productos con stock disponible (quantity - reserved) bajo threshold.
   * Útil para alertas de reposición.
   */
  async lowStock(
    thresholdParam?: string | number,
    warehouseIdParam?: string,
    limitParam?: string | number,
  ) {
    const threshold = Math.max(0, Number(thresholdParam) || 10);
    // Límite duro: el command-center solo muestra los más críticos. Sin esto, con
    // threshold alto sobre el catálogo real la respuesta llegaba a ~10 MB.
    const limit = Math.min(500, Math.max(1, Number(limitParam) || 50));

    return this.tk.run(async (trx) => {
      // Filtro base reutilizable (disponible < threshold + almacén opcional).
      const filtered = () => {
        const q = trx('commercial.stock as s').whereRaw(
          '(s.quantity - s.reserved_quantity) < ?',
          [threshold],
        );
        if (warehouseIdParam) q.where('s.warehouse_id', warehouseIdParam);
        return q;
      };

      // Total real (sin joins) para el contador del dashboard.
      const [{ count }] = await filtered().count('* as count');
      const total = Number(count);

      const rows = await filtered()
        .leftJoin('commercial.warehouses as w', 'w.id', 's.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 's.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
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
        .orderByRaw('(s.quantity - s.reserved_quantity) ASC')
        .limit(limit);

      return {
        threshold,
        warehouse_id: warehouseIdParam || null,
        total,
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
          trx.raw('COUNT(DISTINCT customer_id)::int as unique_customers'),
          trx.raw('COALESCE(SUM(total), 0)::numeric as revenue'),
          trx.raw('COALESCE(SUM(subtotal), 0)::numeric as net_revenue'),
        )
        .groupByRaw(`DATE_TRUNC('day', created_at AT TIME ZONE 'America/Mexico_City')`)
        .orderBy('day', 'asc');

      return rows.map((r) => ({
        day: r.day,
        orders_count: Number(r.orders_count),
        unique_customers: Number(r.unique_customers),
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
    const tenantId = this.tenantCtx.requireTenantId();
    // KV.1: lee venta real de analytics.sales_daily (push on-prem) en vez del FDW
    // analytics_external.ventas_legacy (inalcanzable desde Railway). revenue/units
    // exactos; `lines` = sum(tickets) (proxy de actividad, grano-producto no aditivo);
    // cost/margin = 0 hasta KV.4 (margen con kdpv_prod_util).
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.sales_daily')
        .where('tenant_id', tenantId)
        .modify((qb) => {
          if (from) qb.where('sale_date', '>=', from);
          if (to) qb.where('sale_date', '<=', to);
          if (q.zona)
            qb.whereRaw(
              'warehouse_id IN (SELECT id FROM commercial.warehouses WHERE tenant_id = ? AND (name ILIKE ? OR code = ?))',
              [tenantId, q.zona, q.zona],
            );
        })
        .select(
          'sale_date AS day',
          trx.raw('SUM(tickets)::int AS lines'),
          trx.raw('COALESCE(SUM(units), 0)::numeric AS units'),
          trx.raw('COALESCE(SUM(revenue), 0)::numeric AS revenue'),
        )
        .groupBy('sale_date')
        .orderBy('sale_date', 'asc');
      return rows.map((r) => ({
        day: r.day,
        lines: Number(r.lines),
        units: Number(r.units),
        revenue: Number(r.revenue),
        cost: 0,
        margin: 0,
      }));
    });
  }

  /** Top productos del ERP por revenue en el período. */
  async historicalTopProducts(q: { from?: string; to?: string; zona?: string; limit?: number }) {
    const { from, to } = this.parseDateRange(q);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const tenantId = this.tenantCtx.requireTenantId();
    // KV.1: venta real desde analytics.sales_daily ⋈ catálogo. subfamilia = marca
    // (en Kepler subfamilia == brand). revenue/units exactos.
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.sales_daily AS s')
        .join('catalog.products AS p', 'p.id', 's.product_id')
        .leftJoin('catalog.categories AS cat', 'cat.id', 'p.category_id')
        .leftJoin('catalog.brands AS b', 'b.id', 'p.brand_id')
        .where('s.tenant_id', tenantId)
        .modify((qb) => {
          if (from) qb.where('s.sale_date', '>=', from);
          if (to) qb.where('s.sale_date', '<=', to);
          if (q.zona)
            qb.whereRaw(
              's.warehouse_id IN (SELECT id FROM commercial.warehouses WHERE tenant_id = ? AND (name ILIKE ? OR code = ?))',
              [tenantId, q.zona, q.zona],
            );
        })
        .select(
          'p.id AS producto_id',
          'p.nombre AS producto',
          'cat.name AS categoria',
          'b.nombre AS subfamilia',
          trx.raw('COALESCE(SUM(s.units), 0)::numeric AS units'),
          trx.raw('COALESCE(SUM(s.revenue), 0)::numeric AS revenue'),
        )
        .groupBy('p.id', 'p.nombre', 'cat.name', 'b.nombre')
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
    const tenantId = this.tenantCtx.requireTenantId();
    // KV.2: ranking por venta real desde analytics.product_sales_stats (365d) en
    // vez del FDW ranking_legacy (muerto en Railway). total_cajas no derivable del
    // fact por-producto → 0; piezas = units_365d.
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.product_sales_stats AS s')
        .join('catalog.products AS p', 'p.id', 's.product_id')
        .where('s.tenant_id', tenantId)
        .whereRaw('COALESCE(s.revenue_365d,0) > 0')
        .select('p.sku AS articulo', 'p.nombre AS nombre', 's.units_365d', 's.revenue_365d')
        .orderBy('s.revenue_365d', 'desc')
        .limit(limit);
      return rows.map((r, i) => ({
        posicion: i + 1,
        articulo: r.articulo,
        nombre: r.nombre,
        total_cajas: 0,
        total_piezas: Number(r.units_365d || 0),
        total_piezas_totales: Number(r.units_365d || 0),
        total_venta: Number(r.revenue_365d || 0),
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
    // KV.4: margen por categoría desde analytics.sales_daily (cost = revenue/(1+markup),
    // markup del ERP). Antes leía el FDW ventas_legacy (muerto en Railway). cost/margin
    // sólo de productos con markup; categorías sin costo dan margin_pct NULL.
    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();
      const rows = await trx.raw(
        `
        SELECT
          COALESCE(cat.name, 'Sin categoría')        AS category,
          cat.id                                      AS category_id,
          COUNT(DISTINCT s.product_id)::int           AS products,
          COUNT(*)::int                               AS lines,
          COALESCE(SUM(s.units), 0)::numeric          AS units,
          COALESCE(SUM(s.revenue), 0)::numeric        AS revenue,
          COALESCE(SUM(s.cost), 0)::numeric           AS cost,
          (COALESCE(SUM(s.revenue),0) - COALESCE(SUM(s.cost),0))::numeric AS margin,
          CASE WHEN SUM(s.cost) IS NOT NULL AND SUM(s.revenue) > 0
            THEN ROUND(((SUM(s.revenue) - SUM(s.cost)) / SUM(s.revenue)) * 100, 2)
            ELSE NULL END                             AS margin_pct
        FROM analytics.sales_daily s
        JOIN catalog.products p ON p.id = s.product_id
        LEFT JOIN catalog.categories cat ON cat.id = p.category_id AND cat.tenant_id = ?
        WHERE s.tenant_id = ?
          ${from ? `AND s.sale_date >= ?` : ''}
          ${to ? `AND s.sale_date <= ?` : ''}
        GROUP BY cat.id, cat.name
        ORDER BY revenue DESC
        LIMIT ?
        `,
        [tenantId, tenantId, ...(from ? [from] : []), ...(to ? [to] : []), limit],
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

    return this.guardErp('rankingOutOfStock', [], () =>
     this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();
      // Leemos de la MV LOCAL `products_top_sellers` (sincronizada desde el ERP
      // por cron @15min) en vez de live-joinear el foreign table FDW
      // `analytics_external.ranking_legacy` — el FDW Railway→.245 colgaba el
      // request hasta el gateway timeout (504). Además acotamos el agregado de
      // stock SOLO al topN (antes escaneaba todo el catálogo). Safety net:
      // statement_timeout corta cualquier patología en 15s → guardErp cae a [].
      await trx.raw(`SET LOCAL statement_timeout = '15s'`);
      const rows = await trx.raw(
        `
        WITH top_erp AS (
          SELECT id AS product_id, sku AS articulo, nombre,
                 sales_rank AS posicion, revenue AS total_venta, units_total AS total_piezas_totales
            FROM public.products_top_sellers
           WHERE tenant_id = ?
           ORDER BY sales_rank ASC
           LIMIT ?
        ),
        stock_agg AS (
          SELECT s.product_id,
                 SUM(s.quantity)::numeric AS total_qty,
                 SUM(s.reserved_quantity)::numeric AS total_reserved
            FROM commercial.stock s
           WHERE s.product_id IN (SELECT product_id FROM top_erp)
           GROUP BY s.product_id
        )
        SELECT t.posicion,
               t.articulo,
               t.nombre AS erp_name,
               t.total_venta,
               t.total_piezas_totales,
               t.product_id,
               COALESCE(sa.total_qty, 0)::numeric AS total_qty,
               COALESCE(sa.total_reserved, 0)::numeric AS total_reserved,
               GREATEST(COALESCE(sa.total_qty, 0) - COALESCE(sa.total_reserved, 0), 0)::numeric AS available
          FROM top_erp t
          LEFT JOIN stock_agg sa ON sa.product_id = t.product_id
         WHERE COALESCE(sa.total_qty, 0) - COALESCE(sa.total_reserved, 0) <= 0
         ORDER BY t.posicion ASC
         LIMIT ?
        `,
        [tenantId, topN, limit],
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
    }));
  }

  /** Resumen por zona/sucursal en el período. */
  async historicalSalesByZona(q: { from?: string; to?: string }) {
    const { from, to } = this.parseDateRange(q);
    const tenantId = this.tenantCtx.requireTenantId();
    // KV.1: venta real por almacén desde analytics.sales_daily ⋈ warehouses.
    // revenue/units exactos; tickets = sum proxy (grano-producto, no aditivo);
    // unique_customers = 0 (no derivable del fact por-producto, llega en KV.3).
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.sales_daily AS s')
        .join('commercial.warehouses AS w', 'w.id', 's.warehouse_id')
        .where('s.tenant_id', tenantId)
        .modify((qb) => {
          if (from) qb.where('s.sale_date', '>=', from);
          if (to) qb.where('s.sale_date', '<=', to);
        })
        .select(
          'w.name AS zona',
          'w.code AS almacen',
          trx.raw('SUM(s.tickets)::int AS tickets'),
          trx.raw('COALESCE(SUM(s.units), 0)::numeric AS units'),
          trx.raw('COALESCE(SUM(s.revenue), 0)::numeric AS revenue'),
        )
        .groupBy('w.name', 'w.code')
        .orderBy('revenue', 'desc');
      return rows.map((r) => ({
        zona: r.zona,
        almacen: r.almacen,
        tickets: Number(r.tickets),
        unique_customers: 0,
        units: Number(r.units),
        revenue: Number(r.revenue),
      }));
    });
  }

  // ─────────── KV.3/5/6 — consumo de analytics.* (venta real Kepler) ───────────

  // ── Command Center sobre VENTA REAL de la red (analytics.*, no commercial.orders) ──
  // Estos leen las tablas KV.1/2/3 que los feeds Kepler aterrizan en el platform DB
  // (funcionan en prod). analytics.* NO tiene RLS → filtro tenant_id explícito.

  /** Ventana rolling 30d en TZ MX como expresión SQL reusable. */
  private since30d(trx: any) {
    return trx.raw(`((now() AT TIME ZONE 'America/Mexico_City')::date - 29)`);
  }

  /**
   * KPIs del Command Center desde `analytics.sales_daily` (venta real 30d):
   * venta bruta, costo→margen, unidades, tickets, ticket prom, mix por canal +
   * clientes activos (KV.3). El pipeline (draft/confirmed/cancelled) se conserva
   * de `commercial.orders` — es el único bloque que sigue en data de plataforma.
   */
  async networkOverview() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [tot] = await trx('analytics.sales_daily')
        .where('tenant_id', tenantId)
        .andWhere('sale_date', '>=', this.since30d(trx))
        .select(
          trx.raw('COALESCE(SUM(revenue),0)::numeric AS revenue'),
          trx.raw('COALESCE(SUM(cost),0)::numeric AS cost'),
          trx.raw('COALESCE(SUM(units),0)::numeric AS units'),
          trx.raw('COALESCE(SUM(tickets),0)::int AS tickets'),
          trx.raw('MAX(updated_at) AS updated_at'),
        );

      const channels = await trx('analytics.sales_daily')
        .where('tenant_id', tenantId)
        .andWhere('sale_date', '>=', this.since30d(trx))
        .groupBy('channel')
        .select(
          'channel',
          trx.raw('COALESCE(SUM(revenue),0)::numeric AS revenue'),
          trx.raw('COALESCE(SUM(units),0)::numeric AS units'),
          trx.raw('COALESCE(SUM(tickets),0)::int AS tickets'),
        )
        .orderByRaw('SUM(revenue) DESC');

      const [cust] = await trx('analytics.customer_product_sales')
        .where('tenant_id', tenantId)
        .andWhere('last_purchase_date', '>=', this.since30d(trx))
        .countDistinct<{ n: string }[]>('erp_code as n');

      const pipeRows: any[] = await trx('commercial.orders')
        .whereNull('deleted_at')
        .whereIn('status', ['confirmed', 'draft', 'cancelled'])
        .andWhere('created_at', '>=', this.since30d(trx))
        .groupBy('status')
        .select('status', trx.raw('count(*)::int AS n'));
      const pipe = (s: string) => Number(pipeRows.find((r) => r.status === s)?.n || 0);

      const revenue = Number(tot?.revenue || 0);
      const cost = Number(tot?.cost || 0);
      const margin = revenue - cost;
      const tickets = Number(tot?.tickets || 0);

      return {
        source: 'network',
        updated_at: tot?.updated_at || null,
        period: { rolling_days: 30 },
        revenue: {
          gross: revenue,
          cost,
          margin,
          margin_pct: revenue > 0 ? +((margin / revenue) * 100).toFixed(1) : 0,
          currency: 'MXN',
        },
        units: Number(tot?.units || 0),
        tickets,
        avg_ticket: tickets > 0 ? +(revenue / tickets).toFixed(2) : 0,
        unique_customers: Number(cust?.n || 0),
        by_channel: channels.map((c: any) => ({
          channel: c.channel,
          revenue: Number(c.revenue),
          units: Number(c.units),
          tickets: Number(c.tickets),
          share_pct: revenue > 0 ? +((Number(c.revenue) / revenue) * 100).toFixed(1) : 0,
        })),
        pipeline: {
          confirmed: pipe('confirmed'),
          draft: pipe('draft'),
          cancelled: pipe('cancelled'),
        },
      };
    });
  }

  /** Top productos por venta real 30d desde `analytics.product_sales_stats` (KV.2) + ABC. */
  async networkTopProducts(limitParam?: number | string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(50, Math.max(1, Number(limitParam) || 5));
    return this.tk.run(async (trx) => {
      const rows: any[] = await trx('analytics.product_sales_stats AS s')
        .join('catalog.products AS p', 'p.id', 's.product_id')
        .leftJoin('catalog.brands AS b', 'b.id', 'p.brand_id')
        .where('s.tenant_id', tenantId)
        .andWhere('s.revenue_30d', '>', 0)
        .select(
          's.product_id',
          'p.nombre AS product_name',
          'b.nombre AS brand_name',
          trx.raw('s.units_30d::numeric AS units_sold'),
          trx.raw('s.revenue_30d::numeric AS revenue'),
          's.abc_class',
          trx.raw('s.revenue_share_pct::numeric AS share_pct'),
        )
        .orderBy('s.revenue_30d', 'desc')
        .limit(limit);
      return rows.map((r, i) => ({
        source: 'network',
        product_id: r.product_id,
        product_name: r.product_name,
        brand_name: r.brand_name || '—',
        units_sold: Number(r.units_sold),
        revenue: Number(r.revenue),
        abc_class: r.abc_class || null,
        share_pct: Number(r.share_pct || 0),
        rank_by_revenue: i + 1,
      }));
    });
  }

  /** Mix por marca sobre venta real 30d (analytics.sales_daily join catalog.*). */
  async networkSalesByBrand() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows: any[] = await trx('analytics.sales_daily AS s')
        .join('catalog.products AS p', 'p.id', 's.product_id')
        .leftJoin('catalog.brands AS b', 'b.id', 'p.brand_id')
        .where('s.tenant_id', tenantId)
        .andWhere('s.sale_date', '>=', this.since30d(trx))
        .groupBy('b.id', 'b.nombre')
        .select(
          'b.id AS brand_id',
          'b.nombre AS brand_name',
          trx.raw('COALESCE(SUM(s.units),0)::numeric AS units'),
          trx.raw('COALESCE(SUM(s.revenue),0)::numeric AS revenue'),
        )
        .orderByRaw('SUM(s.revenue) DESC')
        .limit(20);
      const total = rows.reduce((a, r) => a + Number(r.revenue), 0);
      return rows.map((r) => ({
        brand_id: r.brand_id,
        brand_name: r.brand_name || 'Sin marca',
        units: Number(r.units),
        revenue: Number(r.revenue),
        share_pct: total > 0 ? +((Number(r.revenue) / total) * 100).toFixed(2) : 0,
      }));
    });
  }

  /** Serie diaria de venta real (revenue/units/tickets) para el sparkline del hero. */
  async networkDailySeries(q: DateRangeQuery) {
    const { from, to } = this.parseDateRange(q);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows: any[] = await trx('analytics.sales_daily')
        .where('tenant_id', tenantId)
        .modify((qb) => {
          if (from) qb.where('sale_date', '>=', from);
          if (to) qb.where('sale_date', '<=', to);
        })
        .groupBy('sale_date')
        .select(
          trx.raw('sale_date::text AS day'),
          trx.raw('COALESCE(SUM(revenue),0)::numeric AS revenue'),
          trx.raw('COALESCE(SUM(units),0)::numeric AS units'),
          trx.raw('COALESCE(SUM(tickets),0)::int AS tickets'),
        )
        .orderBy('sale_date', 'asc');
      return rows.map((r) => ({
        day: r.day,
        revenue: Number(r.revenue),
        units: Number(r.units),
        tickets: Number(r.tickets),
      }));
    });
  }

  /** KV.5 — Salud de inventario: días de cobertura + status por producto×almacén. */
  async inventoryHealth(q: { warehouse_id?: string; status?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const summary = await trx('analytics.inventory_health AS h')
        .where('h.tenant_id', tenantId)
        .modify((qb) => { if (q.warehouse_id) qb.where('h.warehouse_id', q.warehouse_id); })
        .groupBy('h.status')
        .select('h.status', trx.raw('count(*)::int AS n'));
      const items = await trx('analytics.inventory_health AS h')
        .join('catalog.products AS p', 'p.id', 'h.product_id')
        .leftJoin('commercial.warehouses AS w', 'w.id', 'h.warehouse_id')
        .leftJoin('catalog.brands AS b', 'b.id', 'p.brand_id')
        .where('h.tenant_id', tenantId)
        .modify((qb) => {
          if (q.warehouse_id) qb.where('h.warehouse_id', q.warehouse_id);
          if (q.status) qb.where('h.status', q.status);
        })
        .select(
          'w.code AS warehouse_code', 'p.sku', 'p.nombre AS product_name', 'b.nombre AS brand_name',
          'h.on_hand', 'h.avg_daily_units', 'h.days_cover', 'h.status',
        )
        .orderByRaw('h.days_cover ASC NULLS LAST')
        .limit(2000);
      return { summary, items };
    });
  }

  /** KV.3 — Lista de clientes Kepler con su compra agregada (180d). */
  async erpCustomers(q: { search?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const agg = trx('analytics.customer_product_sales')
        .where('tenant_id', tenantId)
        .groupBy('erp_code')
        .select(
          'erp_code',
          trx.raw('sum(revenue_180d) AS rev_180d'),
          trx.raw('count(*)::int AS products'),
          trx.raw('max(last_purchase_date) AS last_purchase'),
        )
        .as('s');
      return trx('analytics.erp_customers AS c')
        .leftJoin(agg, 's.erp_code', 'c.erp_code')
        .where('c.tenant_id', tenantId)
        .modify((qb) => { if (q.search) qb.whereRaw('c.name ILIKE ?', [`%${q.search}%`]); })
        .select(
          'c.erp_code', 'c.name', 'c.rfc', 'c.city', 's.last_purchase',
          trx.raw('COALESCE(s.rev_180d,0)::numeric AS rev_180d'),
          trx.raw('COALESCE(s.products,0)::int AS products'),
        )
        .orderByRaw('COALESCE(s.rev_180d,0) DESC')
        .limit(limit);
    });
  }

  /** KV.3 — Productos comprados por un cliente Kepler (90/180d). */
  async erpCustomerProducts(erpCode: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) =>
      trx('analytics.customer_product_sales AS s')
        .join('catalog.products AS p', 'p.id', 's.product_id')
        .where('s.tenant_id', tenantId)
        .andWhere('s.erp_code', erpCode)
        .select(
          'p.sku', 'p.nombre AS product_name',
          's.units_90d', 's.revenue_90d', 's.units_180d', 's.revenue_180d', 's.last_purchase_date',
        )
        .orderBy('s.revenue_180d', 'desc')
        .limit(500),
    );
  }

  /** KV.8 — Embarques reales del ERP (kdpord) agregados por dimensión. */
  async erpShipments(q: { from?: string; to?: string; group_by?: string; route?: string; status?: string }) {
    const { from, to } = this.parseDateRange(q);
    const tenantId = this.tenantCtx.requireTenantId();
    const DIMS: Record<string, string> = {
      route: 'route', status: 'status', warehouse: 'warehouse_code',
      day: 'shipped_date', product: 'product_id',
    };
    const dim = DIMS[q.group_by || 'route'] || 'route';
    return this.tk.run(async (trx) => {
      // Degrada a vacío si el feed KV.8 aún no creó la tabla (no aborta la trx).
      const reg = await trx.raw(`SELECT to_regclass('analytics.erp_shipments') AS t`);
      if (!reg.rows?.[0]?.t) {
        return { group_by: q.group_by || 'route', period: { from, to }, source: 'embarques reales ERP (analytics.erp_shipments)', totals: { folios: 0, lines: 0, units: 0 }, rows: [] };
      }
      const base = trx('analytics.erp_shipments AS s')
        .where('s.tenant_id', tenantId)
        .modify((qb) => {
          if (from) qb.where('s.shipped_date', '>=', from);
          if (to) qb.where('s.shipped_date', '<=', to);
          if (q.route) qb.whereRaw('s.route ILIKE ?', [`%${q.route}%`]);
          if (q.status) qb.where('s.status', q.status);
        });
      const rows: any[] = await base.clone()
        .modify((qb) => { if (dim === 'product_id') qb.leftJoin('catalog.products AS p', 'p.id', 's.product_id'); })
        .select(
          trx.raw(`COALESCE(${dim === 'product_id' ? 'p.nombre' : `s.${dim}::text`}, '(s/d)') AS label`),
          trx.raw('COUNT(*)::int AS lines'),
          trx.raw('COUNT(DISTINCT s.shipment_folio)::int AS folios'),
          trx.raw('COALESCE(SUM(s.quantity),0)::numeric AS units'),
        )
        .groupByRaw(dim === 'product_id' ? 'p.nombre' : `s.${dim}`)
        .orderByRaw('SUM(s.quantity) DESC NULLS LAST')
        .limit(200);
      const [tot] = await base.clone().select(
        trx.raw('COUNT(*)::int AS lines'),
        trx.raw('COUNT(DISTINCT s.shipment_folio)::int AS folios'),
        trx.raw('COALESCE(SUM(s.quantity),0)::numeric AS units'),
      );
      return {
        group_by: q.group_by || 'route',
        period: { from: from || null, to: to || null },
        source: 'embarques reales ERP (analytics.erp_shipments)',
        totals: { folios: Number(tot?.folios || 0), lines: Number(tot?.lines || 0), units: Number(tot?.units || 0) },
        rows: rows.map((r: any) => ({ label: r.label, folios: Number(r.folios), lines: Number(r.lines), units: Number(r.units) })),
      };
    });
  }

  /** KV.6 — Promos vigentes del ERP. */
  async erpPromotions() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) =>
      trx('analytics.erp_promotions AS pr')
        .join('catalog.products AS p', 'p.id', 'pr.product_id')
        .leftJoin('catalog.products AS fp', 'fp.id', 'pr.free_product_id')
        .where('pr.tenant_id', tenantId)
        .select(
          'p.sku', 'p.nombre AS product_name', 'pr.promo_type', 'pr.threshold', 'pr.benefit',
          'fp.nombre AS free_product_name', 'pr.valid_from', 'pr.valid_to', 'pr.warehouse_code',
        )
        .orderBy('pr.valid_to', 'asc')
        .limit(1000),
    );
  }

  // ─────────── Fase RS — Generador Sell-Out por empresa (marca/proveedor) ───────────

  /**
   * Reporte Sell-Out: matriz Producto × (Sucursal[×Canal]) con cajas + monto,
   * filtrado por marca/proveedor y periodo. Fuente = `mart.ventas` de la
   * consolidación Kepler (venta real 6 sucursales). Cross-DB: resuelve los SKUs
   * de la marca en `catalog.*` (postgres_platform) y filtra la consolidación.
   *
   *   cajas = SUM(cantidad) / factor_sale (UXC)   ·   monto = SUM(importe)
   *
   * Columnas DINÁMICAS: solo aparecen las sucursales×canales con venta en el
   * periodo. Morelia y Can NO están en la consolidación (ver `coverage.note`).
   */
  async sellOut(q: SellOutQuery): Promise<SellOutReport> {
    const brandId = (q.brand_id || '').trim();
    if (!RS_UUID.test(brandId)) throw new BadRequestException('brand_id inválido');
    if (!q.from || !q.to || !this.isIsoDate(q.from) || !this.isIsoDate(q.to))
      throw new BadRequestException('from/to requeridos (ISO 8601)');
    const from = q.from.slice(0, 10);
    const to = q.to.slice(0, 10);
    if (from > to) throw new BadRequestException('from posterior a to');
    const groupBy: SellOutGroupBy = q.group_by === 'branch' ? 'branch' : 'branch_channel';
    const channelFilter = (q.channels && q.channels.length)
      ? new Set(q.channels.map((c) => c.trim().toLowerCase()).filter(Boolean))
      : null;
    const warehouseFilter = (q.warehouses && q.warehouses.length)
      ? q.warehouses.map((w) => w.trim()).filter(Boolean)
      : null;

    const tenantId = this.tenantCtx.requireTenantId();

    // Canal: analytics.sales_daily ya trae `channel` (tienda/credito/mayoreo/…)
    // derivado de forma_pago por el ETL. Normalizamos a nuestras etiquetas.
    // `mayoreo` = traspaso interno (CEDIS→sucursales) → NO es venta (se excluye).
    const channelExpr = `CASE sd.channel
        WHEN 'tienda'  THEN 'mostrador'
        WHEN 'ruta'    THEN 'ruta'
        WHEN 'credito' THEN 'credito'
        WHEN 'mayoreo' THEN 'traspaso'
        ELSE 'otro' END`;

    // Paso 1 y 2 — marca + agregación desde analytics.sales_daily (misma DB,
    // alimentada por el cron on-prem import-sales-fact.js). Tenant-scoped.
    const { brand, products, raw, retail } = await this.tk.run(async (trx) => {
      const b = await trx('catalog.brands as b')
        .where('b.id', brandId)
        .whereNull('b.deleted_at')
        .select('b.id', 'b.nombre', 'b.code')
        .first();
      if (!b) throw new BadRequestException('Marca no encontrada');

      const ps = q.include_zeros
        ? await trx('catalog.products as p')
            .where('p.brand_id', brandId)
            .whereNull('p.deleted_at')
            .select('p.id', 'p.sku', 'p.nombre', 'p.factor_sale')
            .orderBy('p.nombre')
        : [];

      const rawRows: any[] = await trx('analytics.sales_daily as sd')
        .join('catalog.products as p', 'p.id', 'sd.product_id')
        .join('commercial.warehouses as w', 'w.id', 'sd.warehouse_id')
        .where('sd.tenant_id', tenantId)
        .andWhere('p.brand_id', brandId)
        .andWhere('sd.sale_date', '>=', from)
        .andWhere('sd.sale_date', '<=', to)
        .modify((qb) => { if (warehouseFilter) qb.whereIn('w.code', warehouseFilter); })
        .select(
          'w.code as branch_code',
          'w.name as branch_name',
          'sd.product_id as product_id',
          'p.sku as sku',
          'p.nombre as nombre',
          'p.factor_sale as factor_sale',
          trx.raw(`${channelExpr} as channel`),
        )
        .sum({ units: 'sd.units' })
        .sum({ monto: 'sd.revenue' })
        .groupByRaw(`w.code, w.name, sd.product_id, p.sku, p.nombre, p.factor_sale, ${channelExpr}`);

      // Sucursales con venta (cualquier marca) en el periodo — para cobertura.
      const retailRows = await trx('analytics.sales_daily as sd')
        .join('commercial.warehouses as w', 'w.id', 'sd.warehouse_id')
        .where('sd.tenant_id', tenantId)
        .andWhere('sd.sale_date', '>=', from)
        .andWhere('sd.sale_date', '<=', to)
        .modify((qb) => { if (warehouseFilter) qb.whereIn('w.code', warehouseFilter); })
        .distinct('w.name as name')
        .orderBy('w.name');

      return { brand: b, products: ps, raw: rawRows, retail: retailRows.map((r: any) => r.name) };
    });

    const base: Omit<SellOutReport, 'coverage'> = {
      brand: { id: brand.id, nombre: brand.nombre, code: brand.code ?? null },
      period: { from, to },
      group_by: groupBy,
      columns: [],
      rows: [],
      column_totals: {},
      grand_total: { cajas: 0, monto: 0 },
      generated_at: new Date().toISOString(),
    };

    // Paso 3 — pivote en Node
    const columns = new Map<string, SellOutColumn>();
    const rowMap = new Map<string, SellOutRow>();
    const colTotals = new Map<string, { cajas: number; monto: number }>();
    const branchesWithData = new Set<string>();
    let grandCajas = 0;
    let grandMonto = 0;
    let excludedTransfers = 0;

    for (const r of raw) {
      const channel: string = r.channel;
      if (channel === NON_SALE_CHANNEL) {
        excludedTransfers += Number(r.monto) || 0;
        continue;
      }
      if (channelFilter && !channelFilter.has(channel)) continue;
      const factor = Number(r.factor_sale) > 0 ? Number(r.factor_sale) : 1;
      const units = Number(r.units) || 0;
      const monto = Number(r.monto) || 0;
      const cajas = units / factor;
      branchesWithData.add(r.branch_name);

      const colKey = groupBy === 'branch' ? r.branch_code : `${r.branch_code}|${channel}`;
      if (!columns.has(colKey)) {
        columns.set(colKey, {
          key: colKey,
          branch_code: r.branch_code,
          branch_name: r.branch_name,
          channel: groupBy === 'branch' ? undefined : channel,
          channel_label: groupBy === 'branch' ? undefined : CHANNEL_LABELS[channel] ?? channel,
        });
        colTotals.set(colKey, { cajas: 0, monto: 0 });
      }

      let row = rowMap.get(r.sku);
      if (!row) {
        row = {
          product_id: r.product_id,
          sku: r.sku,
          nombre: r.nombre,
          uxc: r.factor_sale != null ? Number(r.factor_sale) : null,
          cells: {},
          total: { cajas: 0, monto: 0 },
        };
        rowMap.set(r.sku, row);
      }
      const cell = row.cells[colKey] ?? (row.cells[colKey] = { cajas: 0, monto: 0 });
      cell.cajas += cajas;
      cell.monto += monto;
      row.total.cajas += cajas;
      row.total.monto += monto;
      const ct = colTotals.get(colKey)!;
      ct.cajas += cajas;
      ct.monto += monto;
      grandCajas += cajas;
      grandMonto += monto;
    }

    // Filas: incluir SKUs sin venta si include_zeros
    let rows = Array.from(rowMap.values());
    if (q.include_zeros) {
      for (const p of products) {
        if (!rowMap.has(p.sku)) {
          rows.push({
            product_id: p.id,
            sku: p.sku,
            nombre: p.nombre,
            uxc: p.factor_sale != null ? Number(p.factor_sale) : null,
            cells: {},
            total: { cajas: 0, monto: 0 },
          });
        }
      }
    }
    rows.sort((a, b) => b.total.monto - a.total.monto || a.nombre.localeCompare(b.nombre, 'es'));

    // Orden de columnas: por sucursal, luego canal en orden fijo
    const orderedCols = Array.from(columns.values()).sort((a, b) => {
      if (a.branch_code !== b.branch_code) return a.branch_code.localeCompare(b.branch_code);
      return (CHANNEL_ORDER[a.channel ?? ''] ?? 99) - (CHANNEL_ORDER[b.channel ?? ''] ?? 99);
    });

    // Redondeo de presentación
    const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
    for (const row of rows) {
      for (const k of Object.keys(row.cells)) {
        row.cells[k] = { cajas: round(row.cells[k].cajas, 3), monto: round(row.cells[k].monto, 2) };
      }
      row.total = { cajas: round(row.total.cajas, 3), monto: round(row.total.monto, 2) };
    }
    const columnTotalsObj: Record<string, { cajas: number; monto: number }> = {};
    for (const [k, v] of colTotals) columnTotalsObj[k] = { cajas: round(v.cajas, 3), monto: round(v.monto, 2) };

    return {
      ...base,
      columns: orderedCols,
      rows,
      column_totals: columnTotalsObj,
      grand_total: { cajas: round(grandCajas, 3), monto: round(grandMonto, 2) },
      coverage: this.sellOutCoverage(Array.from(branchesWithData), retail, excludedTransfers),
    };
  }

  /** Marcas/proveedores con al menos 1 producto — para el selector de empresa. */
  async sellOutBrands(search?: string): Promise<SellOutBrandRow[]> {
    const term = (search || '').trim();
    return this.tk.run(async (trx) => {
      let q = trx('catalog.brands as b')
        .whereNull('b.deleted_at')
        .whereExists(function () {
          this.select(trx.raw('1'))
            .from('catalog.products as p')
            .whereRaw('p.brand_id = b.id')
            .whereNull('p.deleted_at');
        })
        .select(
          'b.id',
          'b.nombre',
          'b.code',
          trx.raw(
            '(SELECT count(*) FROM catalog.products p WHERE p.brand_id = b.id AND p.deleted_at IS NULL)::int AS products',
          ),
        )
        .orderBy('b.nombre')
        .limit(1000);
      if (term) q = q.where('b.nombre', 'ilike', `%${term}%`);
      return q;
    });
  }

  /** Almacenes/sucursales con venta en analytics.sales_daily — para el selector. */
  async sellOutWarehouses(): Promise<SellOutWarehouseRow[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('analytics.sales_daily as sd')
        .join('commercial.warehouses as w', 'w.id', 'sd.warehouse_id')
        .where('sd.tenant_id', tenantId)
        .distinct('w.code as code', 'w.name as name')
        .orderBy('w.code');
      return rows as SellOutWarehouseRow[];
    });
  }

  /**
   * SAL — Reporte Salidas/Ventas por Producto: fila por (sucursal, producto)
   * con venta+costo mensual, existencia actual, costos y proveedor/marca.
   * Venta mensual = unidades reales (analytics.product_sales_monthly, feed live
   * Kepler U/D/10). Costo mensual = venta × costo_por_caja (fórmula del ERP).
   */
  async salidasReport(q: SalidasQuery): Promise<SalidasReport> {
    const isRange = !!(q.from && q.to);
    const whFilter = (q.warehouses && q.warehouses.length) ? q.warehouses.map((w) => w.trim()).filter(Boolean) : null;
    const brandId = q.brand_id && RS_UUID.test(q.brand_id) ? q.brand_id : null;
    const supplierId = q.supplier_id && RS_UUID.test(q.supplier_id) ? q.supplier_id : null;
    const term = (q.search || '').trim();
    const tenantId = this.tenantCtx.requireTenantId();

    // Modo AÑO → product_sales_monthly (columnas por mes). Modo RANGO → product_sales_daily
    // (una Venta/Costo del período). El diario suma EXACTO al mensual (misma fuente/filtro).
    let year = 0, from = '', toIncl = '', toExcl = '';
    if (isRange) {
      if (!this.isIsoDate(q.from!) || !this.isIsoDate(q.to!)) throw new BadRequestException('from/to inválido (ISO 8601)');
      from = q.from!; toIncl = q.to!;
      if (from > toIncl) throw new BadRequestException('from > to');
    } else {
      year = Number(q.year) || new Date().getFullYear();
      if (year < 2020 || year > 2100) throw new BadRequestException('year inválido');
      from = `${year}-01-01`; toExcl = `${year + 1}-01-01`;
    }
    const src = isRange ? 'analytics.product_sales_daily as m' : 'analytics.product_sales_monthly as m';
    const dcol = isRange ? 'm.sale_date' : 'm.month';

    // SAL.6 — días del período (cobertura) + ventana anterior (tendencia).
    const DAY = 86400000;
    const parseIso = (s: string) => new Date(s + 'T00:00:00Z');
    const isoOf = (d: Date) => d.toISOString().slice(0, 10);
    let diasPeriodo: number, prevFrom = '', prevTo = '';
    if (isRange) {
      diasPeriodo = Math.round((parseIso(toIncl).getTime() - parseIso(from).getTime()) / DAY) + 1;
      const pT = new Date(parseIso(from).getTime() - DAY);
      const pF = new Date(pT.getTime() - (diasPeriodo - 1) * DAY);
      prevTo = isoOf(pT); prevFrom = isoOf(pF);
    } else {
      const yStart = parseIso(from);
      const yEnd = parseIso(`${year}-12-31`);
      const now = new Date();
      const end = now < yEnd ? now : yEnd;
      diasPeriodo = Math.max(1, Math.round((end.getTime() - yStart.getTime()) / DAY) + 1);
    }

    const { salesRows, metaRows, prevRows } = await this.tk.run(async (trx) => {
      const applyDate = (qb: any) => {
        qb.where('m.tenant_id', tenantId).andWhere(dcol, '>=', from);
        if (isRange) qb.andWhere(dcol, '<=', toIncl); else qb.andWhere(dcol, '<', toExcl);
      };
      const applyFilters = (qb: any) => {
        if (whFilter) qb.whereIn('w.code', whFilter);
        if (brandId) qb.andWhere('p.brand_id', brandId);
        if (supplierId) qb.andWhere('p.supplier_id', supplierId);
        if (term) qb.andWhere((b: any) => b.where('p.nombre', 'ilike', `%${term}%`).orWhere('p.sku', 'ilike', `%${term}%`));
      };

      // Venta por (sucursal, producto[, mes]).
      const sq = trx(src)
        .join('catalog.products as p', 'p.id', 'm.product_id')
        .join('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .sum({ units: 'm.units' });
      applyDate(sq);
      if (isRange) {
        sq.select('w.code as wcode', 'm.product_id as product_id').groupByRaw('w.code, m.product_id');
      } else {
        sq.select('w.code as wcode', 'm.product_id as product_id', trx.raw(`to_char(m.month,'MM') as mes`))
          .groupByRaw(`w.code, m.product_id, to_char(m.month,'MM')`);
      }
      applyFilters(sq);

      // Meta + existencia por (sucursal, producto) con venta en el período.
      const mq = trx(src)
        .join('catalog.products as p', 'p.id', 'm.product_id')
        .join('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
        .leftJoin('catalog.suppliers as s', 's.id', 'p.supplier_id')
        .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
        .leftJoin('catalog.categories as cat', 'cat.id', 'p.category_id')
        .leftJoin('commercial.stock as st', function (this: any) {
          this.on('st.product_id', 'm.product_id').andOn('st.warehouse_id', 'm.warehouse_id').andOn('st.tenant_id', 'm.tenant_id');
        })
        .distinct(
          'w.code as wcode', 'w.name as wname', 'm.product_id as product_id',
          'p.sku as sku', 'p.nombre as nombre', 'p.factor_sale as factor_sale',
          'p.cost_with_tax as cost_with_tax', 'p.cost_per_case as cost_per_case',
          's.name as supplier', 'b.nombre as brand', 'cat.name as categoria',
          'p.rotation_tier as rotation_tier', 'st.quantity as stock_qty',
        );
      applyDate(mq);
      applyFilters(mq);

      // SAL.6 — tendencia: venta del período ANTERIOR (misma duración, solo rango).
      let prevRows: any[] = [];
      if (isRange && prevFrom && prevTo) {
        const pq = trx('analytics.product_sales_daily as m')
          .join('catalog.products as p', 'p.id', 'm.product_id')
          .join('commercial.warehouses as w', 'w.id', 'm.warehouse_id')
          .where('m.tenant_id', tenantId).andWhere('m.sale_date', '>=', prevFrom).andWhere('m.sale_date', '<=', prevTo)
          .sum({ units: 'm.units' })
          .select('w.code as wcode', 'm.product_id as product_id')
          .groupByRaw('w.code, m.product_id');
        applyFilters(pq);
        prevRows = await pq;
      }

      return { salesRows: await sq, metaRows: await mq, prevRows };
    });

    // Merge en Node.
    const monthsSet = new Set<string>();
    const salesByKey = new Map<string, Record<string, number>>(); // modo año: mes→units
    const totalByKey = new Map<string, number>();                 // modo rango: units del período
    for (const r of salesRows as any[]) {
      const key = `${r.wcode}|${r.product_id}`;
      if (isRange) {
        totalByKey.set(key, Number(r.units) || 0);
      } else {
        monthsSet.add(r.mes);
        (salesByKey.get(key) ?? salesByKey.set(key, {}).get(key)!)[r.mes] = Number(r.units) || 0;
      }
    }
    const prevByKey = new Map<string, number>();
    for (const r of prevRows as any[]) prevByKey.set(`${r.wcode}|${r.product_id}`, Number(r.units) || 0);
    const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
    const rows: SalidasRow[] = (metaRows as any[]).map((r) => {
      const key = `${r.wcode}|${r.product_id}`;
      const factor = Number(r.factor_sale) > 0 ? Number(r.factor_sale) : 1;
      const costCase = r.cost_per_case != null ? Number(r.cost_per_case) : 0;
      // Costo de la VENTA = unidades × costo UNITARIO (CostoCIVA). La venta está en
      // unidades; multiplicarla por el costo de una CAJA la inflaba ×UXC (bug
      // heredado del Excel). Cae a cost_per_case/UXC si falta cost_with_tax.
      const costUnit = r.cost_with_tax != null ? Number(r.cost_with_tax) : (factor > 0 ? costCase / factor : costCase);
      const monthly: Record<string, { venta: number; costo: number }> = {};
      let ventaTotal = 0, costoTotal = 0;
      if (isRange) {
        ventaTotal = totalByKey.get(key) ?? 0;
        costoTotal = round(ventaTotal * costUnit);
      } else {
        const months = salesByKey.get(key) ?? {};
        for (const [mes, venta] of Object.entries(months)) {
          const costo = round(venta * costUnit);
          monthly[mes] = { venta: round(venta, 2), costo };
          ventaTotal += venta;
          costoTotal += costo;
        }
      }
      const existPaq = Number(r.stock_qty) || 0;
      const existCja = round(existPaq / factor, 2);
      const ventaCajas = round(ventaTotal / factor, 2);
      const diasCobertura = ventaTotal > 0 ? Math.round((existPaq * diasPeriodo) / ventaTotal) : null;
      const ventaPrev = isRange ? (prevByKey.get(key) ?? 0) : null;
      const ventaDelta = isRange && ventaPrev != null && ventaPrev > 0
        ? round(((ventaTotal - ventaPrev) / ventaPrev) * 100, 1) : null;
      return {
        warehouse_code: r.wcode,
        warehouse_name: r.wname,
        product_id: r.product_id,
        sku: r.sku,
        nombre: r.nombre,
        uxc: r.factor_sale != null ? Number(r.factor_sale) : null,
        supplier: r.supplier ?? null,
        brand: r.brand ?? null,
        categoria: r.categoria ?? null,
        rotation_tier: r.rotation_tier ?? null,
        costo_civa: r.cost_with_tax != null ? Number(r.cost_with_tax) : null,
        costo_caja: r.cost_per_case != null ? Number(r.cost_per_case) : null,
        exist_paq: existPaq,
        exist_cja: existCja,
        costo_existencia: round(existCja * costCase),
        monthly,
        venta_total: round(ventaTotal, 2),
        costo_total: round(costoTotal),
        venta_cajas: ventaCajas,
        dias_cobertura: diasCobertura,
        venta_prev: ventaPrev != null ? round(ventaPrev, 2) : null,
        venta_delta_pct: ventaDelta,
      };
    });
    rows.sort((a, b) =>
      a.warehouse_name.localeCompare(b.warehouse_name, 'es') || b.venta_total - a.venta_total,
    );

    const months = Array.from(monthsSet).sort();
    return isRange
      ? { mode: 'range', from, to: toIncl, dias_periodo: diasPeriodo, has_trend: true, months: [], rows, generated_at: new Date().toISOString() }
      : { mode: 'year', year, dias_periodo: diasPeriodo, has_trend: false, months, rows, generated_at: new Date().toISOString() };
  }

  /**
   * RR — Ventas por Ruta: fila por (sucursal, ruta) con venta (importe/unidades/
   * tickets) mes a mes + total + share%. Ruta = serie de folio Kepler `c63`
   * (UD+almacén+ruta); `md_01-003` = PH ruta 03. Fuente: analytics.sales_by_route_monthly
   * (feed live Kepler U/D/10, acumulativo). Historia por ruta se construye hacia adelante.
   */
  async salesByRoute(q: SalesByRouteQuery): Promise<SalesByRouteReport> {
    const year = Number(q.year) || new Date().getFullYear();
    if (year < 2020 || year > 2100) throw new BadRequestException('year inválido');
    const from = `${year}-01-01`;
    const to = `${year + 1}-01-01`;
    const whFilter = (q.warehouses && q.warehouses.length) ? q.warehouses.map((w) => w.trim()).filter(Boolean) : null;
    const tenantId = this.tenantCtx.requireTenantId();

    const rawRows: any[] = await this.tk.run(async (trx) => {
      const qb = trx('analytics.sales_by_route_monthly as s')
        .join('commercial.warehouses as w', 'w.id', 's.warehouse_id')
        .where('s.tenant_id', tenantId)
        .andWhere('s.month', '>=', from)
        .andWhere('s.month', '<', to)
        .select(
          'w.code as wcode', 'w.name as wname', 's.route_code as route_code', 's.route_no as route_no',
          trx.raw(`to_char(s.month,'MM') as mes`),
        )
        .sum({ units: 's.units' })
        .sum({ revenue: 's.revenue' })
        .sum({ tickets: 's.tickets' })
        .groupByRaw(`w.code, w.name, s.route_code, s.route_no, to_char(s.month,'MM')`);
      if (whFilter) qb.whereIn('w.code', whFilter);
      return qb;
    });

    const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
    const monthsSet = new Set<string>();
    const byRoute = new Map<string, SalesByRouteRow>();
    const monthlyTotals: Record<string, SalesByRouteCell> = {};
    const totals: SalesByRouteCell = { revenue: 0, units: 0, tickets: 0 };

    for (const r of rawRows) {
      const key = `${r.wcode}|${r.route_code}`;
      monthsSet.add(r.mes);
      const revenue = Number(r.revenue) || 0;
      const units = Number(r.units) || 0;
      const tickets = Number(r.tickets) || 0;

      let row = byRoute.get(key);
      if (!row) {
        row = {
          warehouse_code: r.wcode,
          warehouse_name: r.wname,
          route_code: r.route_code,
          route_no: r.route_no ?? '—',
          label: `${r.wname} · Ruta ${r.route_no ?? r.route_code}`,
          monthly: {},
          revenue_total: 0,
          units_total: 0,
          tickets_total: 0,
          share_pct: 0,
        };
        byRoute.set(key, row);
      }
      row.monthly[r.mes] = { revenue: round(revenue), units: round(units), tickets };
      row.revenue_total += revenue;
      row.units_total += units;
      row.tickets_total += tickets;

      const mt = monthlyTotals[r.mes] ?? (monthlyTotals[r.mes] = { revenue: 0, units: 0, tickets: 0 });
      mt.revenue += revenue; mt.units += units; mt.tickets += tickets;
      totals.revenue += revenue; totals.units += units; totals.tickets += tickets;
    }

    const rows = Array.from(byRoute.values());
    for (const row of rows) {
      row.revenue_total = round(row.revenue_total);
      row.units_total = round(row.units_total);
      row.share_pct = totals.revenue > 0 ? round((row.revenue_total / totals.revenue) * 100, 1) : 0;
    }
    for (const m of Object.values(monthlyTotals)) { m.revenue = round(m.revenue); m.units = round(m.units); }
    totals.revenue = round(totals.revenue); totals.units = round(totals.units);

    rows.sort((a, b) =>
      a.warehouse_name.localeCompare(b.warehouse_name, 'es') || a.route_no.localeCompare(b.route_no, 'es'),
    );

    const months = Array.from(monthsSet).sort();
    return { year, months, rows, totals, monthly_totals: monthlyTotals, generated_at: new Date().toISOString() };
  }

  /**
   * Fase T — Traspasos / movimientos que NO son venta (analytics.transfers_monthly):
   * consolidación interna (UD06), recepción (UA50), traspasos entrada/salida.
   * Fila por (sucursal, tipo) con valor/unidades/docs mes a mes + share%. Vive en
   * /logistica/traspasos, SEPARADO de todo reporte de venta.
   */
  async transfersReport(q: TransfersQuery): Promise<TransfersReport> {
    const year = Number(q.year) || new Date().getFullYear();
    if (year < 2020 || year > 2100) throw new BadRequestException('year inválido');
    const from = `${year}-01-01`;
    const to = `${year + 1}-01-01`;
    const whFilter = (q.warehouses && q.warehouses.length) ? q.warehouses.map((w) => w.trim()).filter(Boolean) : null;
    const tenantId = this.tenantCtx.requireTenantId();

    const LABEL: Record<TransferKind, string> = {
      consolidacion: 'Consolidación interna',
      recepcion: 'Recepción de traspaso',
      traspaso_salida: 'Salida por traspaso',
      traspaso_entrada: 'Entrada por traspaso',
    };

    const rawRows: any[] = await this.tk.run(async (trx) => {
      const qb = trx('analytics.transfers_monthly as t')
        .join('commercial.warehouses as w', 'w.id', 't.warehouse_id')
        .where('t.tenant_id', tenantId)
        .andWhere('t.month', '>=', from)
        .andWhere('t.month', '<', to)
        .select(
          'w.code as wcode', 'w.name as wname', 't.kind as kind',
          trx.raw(`to_char(t.month,'MM') as mes`),
        )
        .sum({ units: 't.units' })
        .sum({ value: 't.value' })
        .sum({ docs: 't.docs' })
        .groupByRaw(`w.code, w.name, t.kind, to_char(t.month,'MM')`);
      if (whFilter) qb.whereIn('w.code', whFilter);
      return qb;
    });

    const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
    const monthsSet = new Set<string>();
    const byRow = new Map<string, TransfersRow>();
    const monthlyTotals: Record<string, TransfersCell> = {};
    const totals: TransfersCell = { value: 0, units: 0, docs: 0 };
    const kindTotals: Record<string, number> = {};

    for (const r of rawRows) {
      const kind = r.kind as TransferKind;
      const key = `${r.wcode}|${kind}`;
      monthsSet.add(r.mes);
      const value = Number(r.value) || 0;
      const units = Number(r.units) || 0;
      const docs = Number(r.docs) || 0;

      let row = byRow.get(key);
      if (!row) {
        row = {
          warehouse_code: r.wcode,
          warehouse_name: r.wname,
          kind,
          kind_label: LABEL[kind] ?? kind,
          monthly: {},
          value_total: 0,
          units_total: 0,
          docs_total: 0,
          share_pct: 0,
        };
        byRow.set(key, row);
      }
      row.monthly[r.mes] = { value: round(value), units: round(units), docs };
      row.value_total += value;
      row.units_total += units;
      row.docs_total += docs;

      const mt = monthlyTotals[r.mes] ?? (monthlyTotals[r.mes] = { value: 0, units: 0, docs: 0 });
      mt.value += value; mt.units += units; mt.docs += docs;
      totals.value += value; totals.units += units; totals.docs += docs;
      kindTotals[kind] = (kindTotals[kind] || 0) + value;
    }

    const rows = Array.from(byRow.values());
    for (const row of rows) {
      row.value_total = round(row.value_total);
      row.units_total = round(row.units_total);
      row.share_pct = totals.value > 0 ? round((row.value_total / totals.value) * 100, 1) : 0;
    }
    for (const m of Object.values(monthlyTotals)) { m.value = round(m.value); m.units = round(m.units); }
    totals.value = round(totals.value); totals.units = round(totals.units);

    rows.sort((a, b) =>
      a.warehouse_name.localeCompare(b.warehouse_name, 'es') || a.kind_label.localeCompare(b.kind_label, 'es'),
    );

    const by_kind = Object.entries(kindTotals)
      .map(([k, v]) => ({
        kind: k as TransferKind,
        kind_label: LABEL[k as TransferKind] ?? k,
        value: round(v),
        share_pct: totals.value > 0 ? round((v / totals.value) * 100, 1) : 0,
      }))
      .sort((a, b) => b.value - a.value);

    const months = Array.from(monthsSet).sort();
    return { year, months, rows, totals, monthly_totals: monthlyTotals, by_kind, generated_at: new Date().toISOString() };
  }

  private sellOutCoverage(
    withData: string[],
    retail: string[],
    excludedTransfers = 0,
  ): SellOutReport['coverage'] {
    const set = new Set(withData);
    const missing = retail.filter((n) => !set.has(n));
    const parts: string[] = [
      'Fuente: venta consolidada Kepler (analytics.sales_daily). Morelia y Can NO están conectadas a la consolidación, no aparecen en el reporte.',
    ];
    if (excludedTransfers > 0) {
      const m = Math.round(excludedTransfers).toLocaleString('es-MX');
      parts.push(`Se excluyeron traspasos internos (movimientos entre sucursales) por $${m} — no son venta.`);
    }
    if (missing.length)
      parts.push(`Sin venta de esta empresa en el periodo: ${missing.join(', ')}.`);
    return { branches_with_data: withData, branches_missing: missing, note: parts.join(' ') };
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
