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
  /** Marca/empresa. Vacío = TODAS las empresas (reporte general). */
  brand_id?: string;
  from: string;
  to: string;
  group_by?: SellOutGroupBy;
  channels?: string[];
  /** Códigos de almacén (commercial.warehouses.code) a incluir. Vacío = todos. */
  warehouses?: string[];
  include_zeros?: boolean;
  /** Filtro por producto (SKU o nombre, ILIKE) — aplica en todas las empresas. */
  search?: string;
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
  unit_sale: string | null;      // unidad de venta Kepler (PZA/CJA/KGS…) — define si la conversión aplica
  pack_size: number | null;      // pzas por PAQUETE (kdii.c81)
  box_size: number | null;       // pzas por CAJA (kdii.c84) — Kepler rara vez lo define
  supplier: string | null;
  brand: string | null;
  categoria: string | null;      // SAL.6 clasificación
  rotation_tier: string | null;  // SAL.6 ABC/rotación (baja|media|alta)
  costo_civa: number | null;
  costo_caja: number | null;
  // Existencia en los 3 niveles de la jerarquía Kepler. Pieza = base (kdil).
  // Paquete/Caja = null si la unidad no es pieza o si Kepler no define el factor.
  exist_paq: number;             // PIEZA (base)
  exist_paquete: number | null;  // existPaq ÷ pack_size
  exist_caja: number | null;     // existPaq ÷ box_size
  costo_existencia: number;
  monthly: Record<string, { venta: number; costo: number }>;
  venta_total: number;
  costo_total: number;
  venta_paquetes: number | null;   // venta_total ÷ pzas por paquete (null si no hay paquete)
  venta_cajas: number | null;      // venta_total ÷ pzas por caja (null si no hay caja)
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
export type TransferKind = 'salida_cedis' | 'consolidacion' | 'recepcion' | 'traspaso_salida' | 'traspaso_entrada';

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
  dest_label: string;
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
  brand: { id: string | null; nombre: string; code: string | null };
  period: { from: string; to: string };
  group_by: SellOutGroupBy;
  /** Dimensión de las filas: 'brand' = reporte general por empresa · 'product' = detalle. */
  row_dim: 'brand' | 'product';
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
    // El CEDIS central distribuye por TRASPASOS, no por venta → medir "muerto =
    // venta 0" ahí sobre-marca fast-movers (Coca/Takis). Se excluye del reporte.
    const CEDIS_CODE = '00';
    return this.tk.run(async (trx) => {
      // catalog.products (tabla real) — la vista public.products no expone
      // sales_units_30d/rotation_tier (columnas nuevas).
      const base = trx('commercial.stock as s')
        .leftJoin('commercial.warehouses as w', 'w.id', 's.warehouse_id')
        .leftJoin('catalog.products as p', 'p.id', 's.product_id')
        .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
        // La verdad de ventas es analytics.product_sales_stats (mismo fact que el
        // Command Center), NO catalog.products.sales_units_90d (feed de rotación
        // que divergía → falsos positivos). INNER join: sin registro de stats =
        // venta desconocida = NO se marca muerto.
        .join('analytics.product_sales_stats as st', function () {
          this.on('st.product_id', '=', 's.product_id').andOn('st.tenant_id', '=', 's.tenant_id');
        })
        .where('s.quantity', '>', 0)
        // Excluir almacenes soft-deleted (p.ej. warehouses efímeros de tests):
        // sin esto el reporte contaba stock de almacenes ya borrados.
        .whereNull('w.deleted_at')
        .whereNot('w.code', CEDIS_CODE)
        // Ventana 90d sobre el fact autoritativo. = 0 estricto (hay registro y dice 0).
        .where('st.units_90d', 0);
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
        // Excluir stock en almacenes soft-deleted (warehouses efímeros de tests).
        q.whereNotIn(
          's.warehouse_id',
          trx('commercial.warehouses').select('id').whereNotNull('deleted_at'),
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
        .andWhere('p.is_promo', false)
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
        .andWhere('p.is_promo', false)
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
      // Excluir filas de almacenes soft-deleted (warehouses efímeros de tests).
      const notDeletedWh = trx('commercial.warehouses').select('id').whereNotNull('deleted_at');
      const summary = await trx('analytics.inventory_health AS h')
        .where('h.tenant_id', tenantId)
        .whereNotIn('h.warehouse_id', notDeletedWh.clone())
        .modify((qb) => { if (q.warehouse_id) qb.where('h.warehouse_id', q.warehouse_id); })
        .groupBy('h.status')
        .select('h.status', trx.raw('count(*)::int AS n'));
      const items = await trx('analytics.inventory_health AS h')
        .join('catalog.products AS p', 'p.id', 'h.product_id')
        .leftJoin('commercial.warehouses AS w', 'w.id', 'h.warehouse_id')
        .leftJoin('catalog.brands AS b', 'b.id', 'p.brand_id')
        .where('h.tenant_id', tenantId)
        .whereNotIn('h.warehouse_id', notDeletedWh.clone())
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

  // ─────────── GX v2 — Egresos contables (motor dinámico) ───────────

  private static readonly EXPENSE_FILTER_KEYS = [
    'sucursal', 'familia', 'doc_tipo', 'cuenta', 'cuenta_mayor', 'area', 'dpto', 'beneficiario',
    'min_importe', 'max_importe',
  ] as const;

  /** Rango [from,to] con default 90d + período previo del mismo largo. */
  private expenseRange(q: { from?: string; to?: string }) {
    const to = q.to || new Date().toISOString().slice(0, 10);
    const from = q.from || (() => { const d = new Date(to); d.setDate(d.getDate() - 90); return d.toISOString().slice(0, 10); })();
    const DAY = 86400000;
    const span = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1);
    const prev_to = new Date(Date.parse(from) - DAY).toISOString().slice(0, 10);
    const prev_from = new Date(Date.parse(from) - DAY * span).toISOString().slice(0, 10);
    return { from, to, prev_from, prev_to };
  }

  /** Query base de expense_entries con todos los filtros aplicados. */
  private expenseQuery(trx: any, tenantId: string, from: string, to: string, q: any) {
    const b = trx('analytics.expense_entries as e')
      .where('e.tenant_id', tenantId)
      .andWhere('e.fecha', '>=', from)
      .andWhere('e.fecha', '<=', to);
    if (q.sucursal?.length) b.whereIn('e.sucursal', q.sucursal);
    if (q.familia) b.where('e.familia', q.familia);
    if (q.doc_tipo) b.where('e.doc_tipo', q.doc_tipo);
    if (q.cuenta) b.where('e.cuenta', q.cuenta);
    if (q.cuenta_mayor) b.where('e.cuenta_mayor', q.cuenta_mayor);
    if (q.area_null) b.whereNull('e.area');
    else if (q.area) b.where('e.area', q.area);
    if (q.dpto_null) b.whereNull('e.dpto');
    else if (q.dpto) b.where('e.dpto', q.dpto);
    // concepto = 3er nivel contable (nómina bancos, arrendamiento…); se filtra por nombre
    // porque el código c20 se repite entre subcuentas.
    if (q.concepto_null) b.whereNull('e.concepto_nombre');
    else if (q.concepto) b.where('e.concepto_nombre', q.concepto);
    // *_null = drill del bucket "(sin …)"; *_eq = drill exacto desde una fila; beneficiario solo = búsqueda libre (ILIKE)
    if (q.beneficiario_null) b.whereNull('e.beneficiario');
    else if (q.beneficiario_eq) b.where('e.beneficiario', q.beneficiario_eq);
    else if (q.beneficiario) b.whereRaw('e.beneficiario ILIKE ?', [`%${q.beneficiario}%`]);
    if (q.min_importe != null) b.where('e.importe', '>=', q.min_importe);
    if (q.max_importe != null) b.where('e.importe', '<=', q.max_importe);
    return b;
  }

  /** Mapea la dimensión de agrupación (group_by) a SQL. */
  private expenseDim(gb?: string) {
    switch (gb) {
      case 'cuenta_mayor':
        return { key: 'cuenta_mayor', groupSql: 'e.cuenta_mayor, e.cuenta_mayor_nombre', keySql: "COALESCE(e.cuenta_mayor,'-')", labelSql: "CASE WHEN COALESCE(e.cuenta_mayor_nombre,'')<>'' THEN e.cuenta_mayor||' · '||e.cuenta_mayor_nombre ELSE COALESCE(e.cuenta_mayor,'-') END", familia: false };
      case 'beneficiario':
        return { key: 'beneficiario', groupSql: 'e.beneficiario', keySql: "COALESCE(e.beneficiario,'(sin beneficiario)')", labelSql: "COALESCE(e.beneficiario,'(sin beneficiario)')", familia: false };
      case 'sucursal':
        return { key: 'sucursal', groupSql: 'e.sucursal', keySql: 'e.sucursal', labelSql: 'e.sucursal', familia: false };
      case 'doc_tipo':
        return { key: 'doc_tipo', groupSql: 'e.doc_tipo', keySql: 'e.doc_tipo', labelSql: 'e.doc_tipo', familia: false };
      case 'area': // e.area = kdm1.c48 = SOLICITANTE (persona que pide el egreso); key '(sin área)' se mantiene para el drill
        return { key: 'area', groupSql: 'e.area', keySql: "COALESCE(e.area,'(sin área)')", labelSql: "COALESCE(e.area,'(sin solicitante)')", familia: false };
      case 'dpto':
        return { key: 'dpto', groupSql: 'e.dpto, e.dpto_nombre', keySql: "COALESCE(e.dpto,'(sin depto)')", labelSql: "COALESCE(e.dpto_nombre, e.dpto, '(sin depto)')", familia: false };
      case 'concepto':
        return { key: 'concepto', groupSql: 'e.concepto_nombre', keySql: "COALESCE(e.concepto_nombre,'(sin concepto)')", labelSql: "COALESCE(e.concepto_nombre,'(sin concepto)')", familia: false };
      case 'mes':
        return { key: 'mes', groupSql: "to_char(e.fecha,'YYYY-MM')", keySql: "to_char(e.fecha,'YYYY-MM')", labelSql: "to_char(e.fecha,'YYYY-MM')", familia: false };
      case 'cuenta':
      default:
        return { key: 'cuenta', groupSql: 'e.cuenta, e.cuenta_nombre, e.familia', keySql: 'e.cuenta', labelSql: "CASE WHEN COALESCE(e.cuenta_nombre,'')<>'' THEN e.cuenta||' · '||e.cuenta_nombre ELSE e.cuenta END", familia: true };
    }
  }

  /**
   * GX v2 — Egresos contables agregados por dimensión dinámica (`group_by`):
   * cuenta | cuenta_mayor | beneficiario | sucursal | doc_tipo | area | mes.
   * Filtros: from/to (default 90d), sucursal[], familia, doc_tipo, cuenta,
   * cuenta_mayor, area, beneficiario(ILIKE), min/max importe. `compare=true` →
   * Δ% vs período previo del mismo largo. Incluye serie mensual (compras/gastos).
   */
  async expenses(q: any) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to, prev_from, prev_to } = this.expenseRange(q);
    const dim = this.expenseDim(q.group_by);
    return this.tk.run(async (trx) => {
      const base = (f = from, t = to) => this.expenseQuery(trx, tenantId, f, t, q);

      const totalsRow: any = await base().clone()
        .select(trx.raw('COALESCE(SUM(importe),0)::numeric AS total'), trx.raw('COUNT(*)::int AS movs'))
        .first();
      const total = Number(totalsRow?.total || 0);

      const byFamilia = await base().clone()
        .groupBy('e.familia')
        .select('e.familia',
          trx.raw("CASE e.familia WHEN '5' THEN 'Compras / Costo' WHEN '6' THEN 'Gastos' ELSE COALESCE(e.familia,'-') END AS label"),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS total'), trx.raw('COUNT(*)::int AS movs'))
        .orderByRaw('SUM(importe) DESC');

      const rowsQ = base().clone()
        .groupByRaw(dim.groupSql)
        .select(
          trx.raw(`${dim.keySql} AS key`),
          trx.raw(`${dim.labelSql} AS label`),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS total'),
          trx.raw('COUNT(*)::int AS movs'),
        )
        .orderByRaw('SUM(importe) DESC')
        .limit(1000);
      if (dim.familia) rowsQ.select(trx.raw('MAX(e.familia) AS familia'));
      const rows: any[] = await rowsQ;

      let prevMap = new Map<string, number>();
      if (q.compare) {
        const prev = await base(prev_from, prev_to).clone()
          .groupByRaw(dim.groupSql)
          .select(trx.raw(`${dim.keySql} AS key`), trx.raw('SUM(importe)::numeric AS total'));
        prevMap = new Map(prev.map((r: any) => [String(r.key), Number(r.total)]));
      }

      const series = await base().clone()
        .groupByRaw("to_char(e.fecha,'YYYY-MM')")
        .select(
          trx.raw("to_char(e.fecha,'YYYY-MM') AS mes"),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS total'),
          trx.raw("ROUND(COALESCE(SUM(importe) FILTER (WHERE e.familia='5'),0)::numeric,2) AS compras"),
          trx.raw("ROUND(COALESCE(SUM(importe) FILTER (WHERE e.familia='6'),0)::numeric,2) AS gastos"),
        )
        .orderBy('mes');

      return {
        from, to, prev_from, prev_to,
        group_by: dim.key,
        total: +total.toFixed(2),
        movimientos: Number(totalsRow?.movs || 0),
        by_familia: byFamilia.map((r: any) => ({ ...r, total: Number(r.total), movs: Number(r.movs) })),
        rows: rows.map((r: any) => {
          const t = Number(r.total);
          const prev = prevMap.get(String(r.key));
          return {
            key: r.key, label: r.label, familia: r.familia ?? null,
            total: t, movs: Number(r.movs),
            share_pct: total ? +((t / total) * 100).toFixed(1) : 0,
            prev_total: prev ?? null,
            delta_pct: q.compare && prev ? +(((t - prev) / prev) * 100).toFixed(1) : null,
          };
        }),
        series: series.map((r: any) => ({ mes: r.mes, total: Number(r.total), compras: Number(r.compras) || 0, gastos: Number(r.gastos) || 0 })),
      };
    });
  }

  /**
   * GX v2 — Árbol jerárquico para el desglose tipo menú:
   * Familia → Cuenta mayor → Subcuenta. Con totales/movs/share por nodo.
   * Los niveles beneficiario/documento se cargan on-demand vía expenses()/expenseDocuments().
   */
  async expensesTree(q: any) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.expenseRange(q);
    return this.tk.run(async (trx) => {
      const rows: any[] = await this.expenseQuery(trx, tenantId, from, to, q)
        .groupBy('e.familia', 'e.cuenta_mayor', 'e.cuenta_mayor_nombre', 'e.cuenta', 'e.cuenta_nombre', 'e.concepto', 'e.concepto_nombre')
        .select('e.familia', 'e.cuenta_mayor', 'e.cuenta_mayor_nombre', 'e.cuenta', 'e.cuenta_nombre', 'e.concepto', 'e.concepto_nombre',
          trx.raw('ROUND(SUM(importe)::numeric,2) AS total'), trx.raw('COUNT(*)::int AS movs'));

      const total = rows.reduce((a, r) => a + Number(r.total), 0);
      const famLabel = (f: string) => (f === '5' ? 'Compras / Costo' : f === '6' ? 'Gastos' : f || '?');
      const fam = new Map<string, any>();
      for (const r of rows) {
        const fk = r.familia || '?';
        if (!fam.has(fk)) fam.set(fk, { key: fk, label: famLabel(fk), total: 0, movs: 0, children: new Map() });
        const F = fam.get(fk);
        F.total += Number(r.total); F.movs += Number(r.movs);
        const mk = r.cuenta_mayor || '?';
        // Siempre CÓDIGO · nombre para identificación precisa (ej. '601 · SUELDOS Y SALARIOS').
        const mkLabel = r.cuenta_mayor ? (r.cuenta_mayor_nombre ? `${r.cuenta_mayor} · ${r.cuenta_mayor_nombre}` : r.cuenta_mayor) : '?';
        if (!F.children.has(mk)) F.children.set(mk, { key: mk, label: mkLabel, total: 0, movs: 0, children: new Map() });
        const Mn = F.children.get(mk);
        Mn.total += Number(r.total); Mn.movs += Number(r.movs);
        const sk = r.cuenta;
        const skLabel = r.cuenta_nombre ? `${r.cuenta} · ${r.cuenta_nombre}` : r.cuenta;
        if (!Mn.children.has(sk)) Mn.children.set(sk, { key: sk, label: skLabel, total: 0, movs: 0, children: new Map() });
        const Sc = Mn.children.get(sk);
        Sc.total += Number(r.total); Sc.movs += Number(r.movs);
        // Concepto = 4º nivel, SOLO gastos (fam 6/7); compras (5) no llevan concepto.
        if (fk === '6' || fk === '7') {
          const cnombre = r.concepto_nombre || '(sin concepto)';
          const clabel = r.concepto ? `${r.concepto} · ${cnombre}` : cnombre;
          if (!Sc.children.has(cnombre)) Sc.children.set(cnombre, { key: `${sk}|${cnombre}`, label: clabel, total: 0, movs: 0 });
          const C = Sc.children.get(cnombre);
          C.total += Number(r.total); C.movs += Number(r.movs);
        }
      }
      const share = (v: number) => (total ? +((v / total) * 100).toFixed(1) : 0);
      const tree = [...fam.values()]
        .sort((a, b) => b.total - a.total)
        .map((F) => ({
          key: F.key, label: F.label, level: 'familia', total: F.total, movs: F.movs, share_pct: share(F.total),
          children: [...F.children.values()].sort((a: any, b: any) => b.total - a.total).map((Mn: any) => ({
            key: Mn.key, label: Mn.label, level: 'mayor', total: Mn.total, movs: Mn.movs, share_pct: share(Mn.total),
            children: [...Mn.children.values()].sort((a: any, b: any) => b.total - a.total).map((Sc: any) => ({
              key: Sc.key, label: Sc.label, level: 'cuenta', total: Sc.total, movs: Sc.movs, share_pct: share(Sc.total),
              children: [...Sc.children.values()].sort((a: any, b: any) => b.total - a.total)
                .map((C: any) => ({ ...C, level: 'concepto', share_pct: share(C.total) })),
            })),
          })),
        }));
      return { from, to, total: +total.toFixed(2), tree };
    });
  }

  /** GX v2 — Renglones de egreso de un documento (drill final). */
  async expenseDocuments(q: any) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.expenseRange(q);
    return this.tk.run(async (trx) => {
      const items = await this.expenseQuery(trx, tenantId, from, to, q)
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', 'e.tenant_id').andOn('w.code', 'e.sucursal');
        })
        .select('e.fecha', 'e.sucursal', 'w.name as sucursal_nombre', 'e.doc_tipo', 'e.doc_folio',
          'e.beneficiario', 'e.beneficiario_doc', 'e.cuenta', 'e.cuenta_nombre', 'e.concepto_nombre',
          'e.comentario', 'e.area', trx.raw('e.importe::numeric AS importe'))
        .orderBy('e.fecha', 'desc')
        .limit(3000);
      return items.map((r: any) => ({ ...r, importe: Number(r.importe) }));
    });
  }

  /**
   * GX v3 — Drill al documento fuente detrás de una póliza de egreso.
   * Devuelve: cabecera del documento (proveedor, RFC, concepto, área, total, IVA),
   * las posturas contables (renglones de la póliza) y las líneas de producto
   * (solo compras XA2001; los gastos XA1001 no tienen líneas en Kepler).
   */
  async expenseDocument(q: { sucursal: string; doc_tipo: string; folio: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { sucursal, doc_tipo, folio } = q;
    if (!sucursal || !doc_tipo || !folio) return { header: null, postings: [], lines: [] };
    return this.tk.run(async (trx) => {
      const key = { tenant_id: tenantId, sucursal, doc_tipo, doc_folio: folio };

      const header = await trx('analytics.expense_documents as d')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', 'd.tenant_id').andOn('w.code', 'd.sucursal');
        })
        // columnas calificadas con d.* — el join con warehouses también tiene tenant_id/sucursal (evita 42702 ambiguo)
        .where({ 'd.tenant_id': tenantId, 'd.sucursal': sucursal, 'd.doc_tipo': doc_tipo, 'd.doc_folio': folio })
        .select('d.sucursal', 'w.name as sucursal_nombre', 'd.doc_tipo', 'd.doc_folio',
          'd.fecha', 'd.fecha_doc', 'd.beneficiario', 'd.rfc', 'd.concepto', 'd.area',
          trx.raw('d.importe::numeric AS importe'), trx.raw('d.iva::numeric AS iva'),
          'd.usuario', 'd.clase', 'd.solicitud_tipo', 'd.solicitud_folio')
        .first();

      const postings = await trx('analytics.expense_entries')
        .where(key)
        .select('linea', 'cuenta', 'cuenta_nombre', 'cuenta_mayor', 'familia',
          'concepto_nombre', 'comentario', 'beneficiario_doc',
          trx.raw('importe::numeric AS importe'))
        .orderBy('linea');

      const lines = await trx('analytics.expense_document_lines')
        .where(key)
        .select('linea', 'sku', 'producto', trx.raw('cantidad::numeric AS cantidad'),
          'presentacion', trx.raw('costo_unitario::numeric AS costo_unitario'),
          trx.raw('importe::numeric AS importe'))
        .orderBy('importe', 'desc');

      // MAAT.1 — cadena de aprovisionamiento (solo compras XA2001; feed import-ledger-chain)
      let chain = null;
      if (doc_tipo === 'XA2001') {
        const ch = await trx('analytics.expense_doc_chain')
          .where({ tenant_id: tenantId, sucursal, factura_folio: folio })
          .select('orden_folio', 'orden_fecha', 'recepcion_folio', 'recepcion_fecha',
            'factura_folio', 'factura_fecha', 'pago_folio', 'pago_fecha',
            'lead_days', 'pago_days', 'match_confidence')
          .first();
        if (ch) chain = { ...ch, lead_days: ch.lead_days != null ? Number(ch.lead_days) : null, pago_days: ch.pago_days != null ? Number(ch.pago_days) : null };
      }

      // GX.6 — cadena de gasto: la solicitud (XA1501) que originó este gasto (XA1001).
      let request = null;
      if (doc_tipo === 'XA1001' && header?.solicitud_folio) {
        const rq = await trx('analytics.expense_requests')
          .where({ tenant_id: tenantId, sucursal, folio: header.solicitud_folio })
          .select('folio', 'fecha', trx.raw('importe::numeric AS importe'), 'solicitante', 'beneficiario', 'concepto', 'estado', 'usuario', 'aplicada')
          .first();
        if (rq) {
          const lead = header.fecha && rq.fecha ? Math.round((Date.parse(String(header.fecha)) - Date.parse(String(rq.fecha))) / 86400000) : null;
          request = { ...rq, importe: Number(rq.importe), lead_days: Number.isFinite(lead) ? lead : null };
        }
      }

      return {
        header: header
          ? { ...header, importe: Number(header.importe), iva: Number(header.iva) }
          : null,
        request,
        postings: postings.map((r: any) => ({ ...r, importe: Number(r.importe) })),
        lines: lines.map((r: any) => ({
          ...r,
          cantidad: r.cantidad != null ? Number(r.cantidad) : null,
          costo_unitario: r.costo_unitario != null ? Number(r.costo_unitario) : null,
          importe: Number(r.importe),
        })),
        chain,
      };
    });
  }

  /**
   * GX.6 — Solicitudes de gasto (XA1501) con su estado y si ya se aplicaron (gasto
   * XA1001). KPIs + filas para la página "Solicitudes de gasto". Filtros: from/to,
   * sucursal[], estado (F/A/C/N), solicitante (ILIKE), aplicada (bool), search.
   */
  async expenseRequests(q: {
    from?: string; to?: string; sucursal?: string[]; estado?: string;
    solicitante?: string; aplicada?: boolean; search?: string; limit?: number;
  }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(5000, Math.max(1, Number(q.limit) || 2000));
    return this.tk.run(async (trx) => {
      const applyFilters = (b: any) => {
        b.where('r.tenant_id', tenantId);
        if (q.from) b.andWhere('r.fecha', '>=', q.from);
        if (q.to) b.andWhere('r.fecha', '<=', q.to);
        if (q.sucursal?.length) b.whereIn('r.sucursal', q.sucursal);
        if (q.estado) b.where('r.estado', q.estado);
        if (q.solicitante?.trim()) b.whereRaw('r.solicitante ILIKE ?', [`%${q.solicitante.trim()}%`]);
        if (q.aplicada != null) b.where('r.aplicada', q.aplicada);
        if (q.search?.trim()) {
          const s = `%${q.search.trim()}%`;
          b.andWhere((w: any) => w.whereRaw('r.folio ILIKE ?', [s]).orWhereRaw('r.beneficiario ILIKE ?', [s]).orWhereRaw('r.concepto ILIKE ?', [s]));
        }
        return b;
      };

      const k: any = await applyFilters(trx('analytics.expense_requests as r'))
        .select(
          trx.raw('COUNT(*)::int AS total'),
          trx.raw('COALESCE(SUM(r.importe),0)::numeric AS importe'),
          trx.raw("COUNT(*) FILTER (WHERE NOT r.aplicada AND r.estado <> 'C')::int AS pendientes"),
          trx.raw("COALESCE(SUM(r.importe) FILTER (WHERE NOT r.aplicada AND r.estado <> 'C'),0)::numeric AS pendientes_importe"),
          trx.raw('COUNT(*) FILTER (WHERE r.aplicada)::int AS aplicadas'),
        ).first();

      const rows = await applyFilters(trx('analytics.expense_requests as r'))
        .leftJoin('commercial.warehouses as w', function () { this.on('w.tenant_id', 'r.tenant_id').andOn('w.code', 'r.sucursal'); })
        .leftJoin('analytics.expense_documents as g', function () {
          this.on('g.tenant_id', 'r.tenant_id').andOn('g.sucursal', 'r.sucursal').andOn('g.solicitud_folio', 'r.folio').andOnVal('g.doc_tipo', 'XA1001');
        })
        .select('r.folio', 'r.sucursal', 'w.name as sucursal_nombre', 'r.fecha',
          trx.raw('r.importe::numeric AS importe'), 'r.solicitante', 'r.beneficiario', 'r.concepto',
          'r.estado', 'r.aplicada', 'g.doc_folio as gasto_folio', 'g.fecha as gasto_fecha',
          trx.raw('(g.fecha - r.fecha) AS lead_days'))
        .orderBy('r.fecha', 'desc')
        .limit(limit);

      return {
        kpis: {
          total: Number(k?.total || 0),
          importe: Number(k?.importe || 0),
          pendientes: Number(k?.pendientes || 0),
          pendientes_importe: Number(k?.pendientes_importe || 0),
          aplicadas: Number(k?.aplicadas || 0),
        },
        rows: rows.map((x: any) => ({ ...x, importe: Number(x.importe), lead_days: x.lead_days != null ? Number(x.lead_days) : null })),
      };
    });
  }

  /**
   * GX v3 — Auxiliar de proveedores (cuenta 201): compra, pagos, saldo, #facturas,
   * última compra y DPO (días de pago aprox). Agregado por proveedor a través de
   * las sucursales. Filtros: search (ILIKE), sucursal[], limit.
   */
  async apProviders(q: { search?: string; sucursal?: string[]; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('analytics.ap_provider').where('tenant_id', tenantId);
      if (q.sucursal?.length) b.whereIn('sucursal', q.sucursal);
      if (q.search?.trim()) b.whereRaw('proveedor ILIKE ?', [`%${q.search.trim()}%`]);
      const rows = await b
        .groupBy('proveedor_norm')
        .select(
          trx.raw('MAX(proveedor) AS proveedor'),
          trx.raw('SUM(compra_12m)::numeric AS compra_12m'),
          trx.raw('SUM(pagos_12m)::numeric AS pagos_12m'),
          trx.raw('SUM(saldo)::numeric AS saldo'),
          trx.raw('SUM(num_facturas)::int AS num_facturas'),
          trx.raw('MAX(ultima_compra) AS ultima_compra'),
          trx.raw('ROUND(AVG(dpo_dias))::int AS dpo_dias'),
        )
        .orderByRaw('SUM(compra_12m) DESC')
        .limit(limit);
      const totalCompra = rows.reduce((a: number, r: any) => a + Number(r.compra_12m), 0);
      return rows.map((r: any) => ({
        proveedor: r.proveedor,
        compra_12m: Number(r.compra_12m),
        pagos_12m: Number(r.pagos_12m),
        saldo: Number(r.saldo),
        num_facturas: Number(r.num_facturas),
        ultima_compra: r.ultima_compra,
        dpo_dias: r.dpo_dias != null ? Number(r.dpo_dias) : null,
        share_pct: totalCompra ? +((Number(r.compra_12m) / totalCompra) * 100).toFixed(1) : 0,
      }));
    });
  }

  /**
   * GX v3 — Hallazgos contables navegables (antes CSV para finanzas):
   * tipo = iva_bug | prov_203 | anticipo_107. Devuelve resumen por tipo + filas.
   */
  async expenseFindings(q: { tipo?: string; sucursal?: string[]; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(5000, Math.max(1, Number(q.limit) || 500));
    return this.tk.run(async (trx) => {
      // alias f.* en todo — la query de filas hace join con warehouses (que también
      // tiene tenant_id) → calificar evita el 42702 "column reference ambiguous".
      const base = () => {
        const b = trx('analytics.expense_findings as f').where('f.tenant_id', tenantId);
        if (q.sucursal?.length) b.whereIn('f.sucursal', q.sucursal);
        return b;
      };
      const summary = await base()
        .groupBy('f.tipo')
        .select('f.tipo as tipo', trx.raw('COUNT(*)::int AS num'), trx.raw('ROUND(SUM(f.importe)::numeric,2) AS total'))
        .orderByRaw('SUM(f.importe) DESC');

      let rows: any[] = [];
      if (q.tipo) {
        rows = await base().where('f.tipo', q.tipo)
          .leftJoin('commercial.warehouses as w', function () {
            this.on('w.tenant_id', 'f.tenant_id').andOn('w.code', 'f.sucursal');
          })
          .select('f.fecha', 'f.sucursal', 'w.name as sucursal_nombre', 'f.doc_tipo', 'f.doc_folio',
            'f.beneficiario', 'f.cuenta', trx.raw('f.importe::numeric AS importe'), 'f.nota')
          .orderBy('f.importe', 'desc')
          .limit(limit);
      }
      return {
        summary: summary.map((s: any) => ({ tipo: s.tipo, num: Number(s.num), total: Number(s.total) })),
        tipo: q.tipo || null,
        rows: rows.map((r: any) => ({ ...r, importe: Number(r.importe) })),
      };
    });
  }

  /**
   * GX.4.2 — Proveedor 360: lo que el desglose genérico no tiene. Resumen de la
   * cuenta 201 (saldo/pagos/DPO/última compra desde ap_provider) + top productos
   * que se le compran (desde expense_document_lines). El resto (compra/tendencia/
   * documentos) ya lo trae /expenses con beneficiario_eq.
   */
  async expenseProvider(q: { key: string; sucursal?: string[] }) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!q.key) return { summary: null, top_products: [] };
    return this.tk.run(async (trx) => {
      const ap = trx('analytics.ap_provider').where('tenant_id', tenantId).where('proveedor', q.key);
      if (q.sucursal?.length) ap.whereIn('sucursal', q.sucursal);
      const s: any = await ap.select(
        trx.raw('MAX(proveedor) AS proveedor'),
        trx.raw('SUM(compra_12m)::numeric AS compra_12m'),
        trx.raw('SUM(pagos_12m)::numeric AS pagos_12m'),
        trx.raw('SUM(saldo)::numeric AS saldo'),
        trx.raw('SUM(num_facturas)::int AS num_facturas'),
        trx.raw('MAX(ultima_compra) AS ultima_compra'),
      ).first();

      const lp = trx('analytics.expense_document_lines as l')
        .join('analytics.expense_documents as d', function () {
          this.on('d.tenant_id', 'l.tenant_id').andOn('d.sucursal', 'l.sucursal')
            .andOn('d.doc_tipo', 'l.doc_tipo').andOn('d.doc_folio', 'l.doc_folio');
        })
        .where('l.tenant_id', tenantId).where('d.beneficiario', q.key);
      if (q.sucursal?.length) lp.whereIn('l.sucursal', q.sucursal);
      const products = await lp
        .groupBy('l.sku')
        .select('l.sku',
          trx.raw('MAX(l.producto) AS producto'),
          trx.raw('SUM(l.cantidad)::numeric AS cantidad'),
          trx.raw('SUM(l.importe)::numeric AS importe'),
          trx.raw('COUNT(DISTINCT l.doc_folio)::int AS docs'))
        .orderByRaw('SUM(l.importe) DESC')
        .limit(20);

      const has = s && Number(s.compra_12m) > 0;
      const compra = Number(s?.compra_12m || 0);
      const saldo = Number(s?.saldo || 0);
      // DPO ponderado desde los agregados (no AVG por-sucursal, que sesga con sucursales chicas)
      const dpo = compra > 0 && saldo > 0 ? Math.round(saldo / (compra / 365)) : null;
      return {
        summary: has ? {
          proveedor: s.proveedor,
          compra_12m: compra,
          pagos_12m: Number(s.pagos_12m),
          saldo,
          num_facturas: Number(s.num_facturas),
          dpo_dias: dpo,
          ultima_compra: s.ultima_compra,
        } : null,
        top_products: products.map((r: any) => ({
          sku: r.sku, producto: r.producto,
          cantidad: r.cantidad != null ? Number(r.cantidad) : null,
          importe: Number(r.importe), docs: Number(r.docs),
        })),
      };
    });
  }

  /** GX v2 — Valores para poblar los filtros del reporte (tipos doc, áreas, mayores). */
  async expensesFilters() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const base = () => trx('analytics.expense_entries').where('tenant_id', tenantId);
      const [doc_tipos, areas, mayores, dptos, conceptos] = await Promise.all([
        base().distinct('doc_tipo').whereNotNull('doc_tipo').orderBy('doc_tipo').then((r) => r.map((x: any) => x.doc_tipo)),
        base().distinct('area').whereNotNull('area').orderBy('area').then((r) => r.map((x: any) => x.area)),
        base().distinct('cuenta_mayor', 'cuenta_mayor_nombre').whereNotNull('cuenta_mayor').orderBy('cuenta_mayor')
          .then((r) => r.map((x: any) => ({ code: x.cuenta_mayor, nombre: x.cuenta_mayor_nombre }))),
        base().distinct('dpto', 'dpto_nombre').whereNotNull('dpto').orderBy('dpto')
          .then((r) => r.map((x: any) => ({ code: x.dpto, nombre: x.dpto_nombre }))),
        base().distinct('concepto_nombre').whereNotNull('concepto_nombre').orderBy('concepto_nombre')
          .then((r) => r.map((x: any) => x.concepto_nombre)),
      ]);
      return { doc_tipos, areas, mayores, dptos, conceptos };
    });
  }

  /** GX — Sucursales presentes en egresos (para el selector del reporte). */
  async expensesSucursales() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) =>
      trx('analytics.expense_entries as e')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', 'e.tenant_id').andOn('w.code', 'e.sucursal');
        })
        .where('e.tenant_id', tenantId)
        .groupBy('e.sucursal', 'w.name')
        .select('e.sucursal as code', 'w.name')
        .orderBy('e.sucursal'),
    );
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
    if (brandId && !RS_UUID.test(brandId)) throw new BadRequestException('brand_id inválido');
    const search = (q.search || '').trim();
    // Sin empresa y sin búsqueda → reporte GENERAL agrupado por EMPRESA (matriz chica,
    // ~decenas de filas). Con empresa elegida o búsqueda → detalle por PRODUCTO.
    const byBrand = !brandId && !search;
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
      const b = brandId
        ? await trx('catalog.brands as b')
            .where('b.id', brandId)
            .whereNull('b.deleted_at')
            .select('b.id', 'b.nombre', 'b.code')
            .first()
        : { id: null, nombre: 'Todas las empresas', code: null };
      if (!b) throw new BadRequestException('Marca no encontrada');

      // include_zeros solo con marca elegida (sin marca sería traer el catálogo completo de todas las empresas).
      const ps = (q.include_zeros && brandId)
        ? await trx('catalog.products as p')
            .where('p.brand_id', brandId)
            .whereNull('p.deleted_at')
            .andWhere('p.is_promo', false)
            .modify((qb) => { if (search) qb.whereRaw('(p.sku ILIKE ? OR p.nombre ILIKE ?)', [`%${search}%`, `%${search}%`]); })
            .select('p.id', 'p.sku', 'p.nombre', 'p.factor_sale')
            .orderBy('p.nombre')
        : [];

      // is_promo fuera: marcadores de promo Kepler (precio simbólico $0.01) —
      // registran la aplicación de la promo en el ticket, no venta de producto.
      const rawRows: any[] = await trx('analytics.sales_daily as sd')
        .join('catalog.products as p', 'p.id', 'sd.product_id')
        .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
        .join('commercial.warehouses as w', 'w.id', 'sd.warehouse_id')
        .where('sd.tenant_id', tenantId)
        .andWhere('p.is_promo', false)
        .modify((qb) => {
          if (brandId) qb.andWhere('p.brand_id', brandId);
          if (search) qb.andWhereRaw('(p.sku ILIKE ? OR p.nombre ILIKE ?)', [`%${search}%`, `%${search}%`]);
        })
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
          'p.brand_id as brand_id',
          'b.nombre as brand_nombre',
          'b.code as brand_code',
          trx.raw(`${channelExpr} as channel`),
        )
        .sum({ units: 'sd.units' })
        .sum({ monto: 'sd.revenue' })
        .groupByRaw(`w.code, w.name, sd.product_id, p.sku, p.nombre, p.factor_sale, p.brand_id, b.nombre, b.code, ${channelExpr}`);

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
      row_dim: byBrand ? 'brand' : 'product',
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

      // byBrand → una fila por EMPRESA (product_id lleva el brand_id para el drill).
      const rowKey = byBrand ? (r.brand_id || 'sin-empresa') : r.sku;
      let row = rowMap.get(rowKey);
      if (!row) {
        row = byBrand
          ? {
              product_id: r.brand_id || '',
              sku: r.brand_code || '',
              nombre: r.brand_nombre || 'Sin empresa',
              uxc: null,
              cells: {},
              total: { cajas: 0, monto: 0 },
            }
          : {
              product_id: r.product_id,
              sku: r.sku,
              nombre: r.nombre,
              uxc: r.factor_sale != null ? Number(r.factor_sale) : null,
              cells: {},
              total: { cajas: 0, monto: 0 },
            };
        rowMap.set(rowKey, row);
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
        .leftJoin('commercial.product_label_prices as lp', function (this: any) {
          this.on('lp.product_id', 'm.product_id').andOn('lp.tenant_id', 'm.tenant_id');
        })
        .distinct(
          'w.code as wcode', 'w.name as wname', 'm.product_id as product_id',
          'p.sku as sku', 'p.nombre as nombre', 'p.factor_sale as factor_sale', 'p.unit_sale as unit_sale',
          'lp.pack_size as pack_size', 'lp.box_size as box_size',
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
      // Jerarquía de unidades Kepler: PIEZA (base) → PAQUETE (pzas por paquete,
      // kdii.c81) → CAJA (pzas por caja, kdii.c84). factor_sale coincide con
      // pack_size en Kepler → fallback del paquete. La conversión SOLO aplica si
      // la unidad es pieza; para CJA (ya en caja) o KGS (granel) dividir descuadra
      // → null y la UI muestra "—". Caja suele venir sin factor (c84=0) → "—".
      const unitSale = String(r.unit_sale ?? '').trim().toUpperCase();
      const pieceUnit = unitSale === '' || unitSale === 'PZA' || unitSale === 'PZAS' || unitSale === 'PIEZA' || unitSale === 'PZ';
      // packF/boxF ESTRICTOS del catálogo de etiquetas (pack_size=PAQ, box_size=CJA,
      // ya mapeados por etiqueta en import-label-data). Sin fallback a factor_sale
      // (que es ambiguo: para el 75% del catálogo el "factor de venta" es la CAJA,
      // no el paquete). Null → la columna muestra "—".
      const packF = Number(r.pack_size) > 0 ? Number(r.pack_size) : 0;
      const boxF = Number(r.box_size) > 0 ? Number(r.box_size) : 0;
      const existPaquete = pieceUnit && packF > 0 ? round(existPaq / packF, 2) : null;
      const existCaja = pieceUnit && boxF > 0 ? round(existPaq / boxF, 2) : null;
      const ventaPaquetes = pieceUnit && packF > 0 ? round(ventaTotal / packF, 2) : null;
      const ventaCajas = pieceUnit && boxF > 0 ? round(ventaTotal / boxF, 2) : null;
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
        unit_sale: r.unit_sale ?? null,
        pack_size: r.pack_size != null ? Number(r.pack_size) : null,
        box_size: r.box_size != null && Number(r.box_size) > 0 ? Number(r.box_size) : null,
        supplier: r.supplier ?? null,
        brand: r.brand ?? null,
        categoria: r.categoria ?? null,
        rotation_tier: r.rotation_tier ?? null,
        costo_civa: r.cost_with_tax != null ? Number(r.cost_with_tax) : null,
        costo_caja: r.cost_per_case != null ? Number(r.cost_per_case) : null,
        exist_paq: existPaq,
        exist_paquete: existPaquete,
        exist_caja: existCaja,
        costo_existencia: round(existPaq * costUnit),
        monthly,
        venta_total: round(ventaTotal, 2),
        costo_total: round(costoTotal),
        venta_paquetes: ventaPaquetes,
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
   * tickets) mes a mes + total + share%. Fuente única: analytics.sales_by_route_monthly,
   * que mezcla DOS orígenes sin doble-conteo:
   *   • Kepler (route_code = serie de folio `c63`, UD+almacén+ruta; `md_01-003` = PH
   *     ruta 03): feed live U/D/10 acumulativo, historia hacia adelante.
   *   • Wincaja venta a bordo (route_code = 'WIN-<code>'): feed import-wincaja-routes-
   *     monthly.js, atribuida a la sucursal MADRE. Padre Hidalgo se corta en 31/05/2026
   *     (Wincaja hasta may, Kepler desde jun) → cero solape de mes.
   * El endpoint no distingue origen: agrega ambos por (sucursal, ruta, mes).
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
      salida_cedis: 'Salida CEDIS',
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
          'w.code as wcode', 'w.name as wname', 't.kind as kind', 't.dest_label as dest_label',
          trx.raw(`to_char(t.month,'MM') as mes`),
        )
        .sum({ units: 't.units' })
        .sum({ value: 't.value' })
        .sum({ docs: 't.docs' })
        .groupByRaw(`w.code, w.name, t.kind, t.dest_label, to_char(t.month,'MM')`);
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
      const dest = r.dest_label ?? '';
      const key = `${r.wcode}|${kind}|${dest}`;
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
          dest_label: dest,
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
      // share DENTRO del tipo (los tipos NO son sumables: son la misma mercancía en
      // etapas distintas — salida CEDIS → consolidación → venta). Compartir contra el
      // total mezclado sería doble conteo.
      const kt = kindTotals[row.kind] || 0;
      row.share_pct = kt > 0 ? round((row.value_total / kt) * 100, 1) : 0;
    }
    for (const m of Object.values(monthlyTotals)) { m.value = round(m.value); m.units = round(m.units); }
    totals.value = round(totals.value); totals.units = round(totals.units);

    rows.sort((a, b) =>
      a.warehouse_name.localeCompare(b.warehouse_name, 'es')
      || a.kind_label.localeCompare(b.kind_label, 'es')
      || (b.value_total - a.value_total)
      || a.dest_label.localeCompare(b.dest_label, 'es'),
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
