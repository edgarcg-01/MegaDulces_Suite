import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CommercialAnalyticsService } from '../../commercial-analytics/commercial-analytics.service';
import { ThotService } from '../thot.service';
import { ThotToolDef, ThotToolProvider, ThotScope } from './thot-tool-provider';
import { buildThotSystemPrompt } from './thot-semantic';

/**
 * TC.0 — Tool registry de Thot Chat (ADR-026).
 *
 * Catálogo curado de herramientas que el LLM puede invocar. Cada tool envuelve
 * un método DETERMINISTA ya tenant-scoped (RLS). El LLM nunca toca SQL ni
 * calcula: orquesta estas tools y narra el resultado. Namespacing `thot_*`.
 *
 * `definitions()` → schema Anthropic para el request. `execute()` → corre la tool
 * con tenant context activo y devuelve JSON. Ante error/tabla vacía devuelve
 * `{ error }` accionable (self-correction de TC.1), nunca lanza.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Métricas y dimensiones permitidas en flexible_aggregate (whitelist, anti-injection). */
const FLEX_METRICS: Record<string, string> = {
  revenue: 'COALESCE(SUM(s.revenue),0)',
  units: 'COALESCE(SUM(s.units),0)',
  tickets: 'COALESCE(SUM(s.tickets),0)',
};
const FLEX_DIMS: Record<string, { join: string; group: string; label: string; time?: boolean }> = {
  product: { join: 'JOIN catalog.products p ON p.id = s.product_id', group: 'p.id, p.nombre', label: 'p.nombre' },
  brand: {
    join: 'JOIN catalog.products p ON p.id = s.product_id LEFT JOIN catalog.brands b ON b.id = p.brand_id',
    group: 'b.id, b.nombre', label: "COALESCE(b.nombre,'(sin marca)')",
  },
  category: {
    join: 'JOIN catalog.products p ON p.id = s.product_id LEFT JOIN catalog.categories cat ON cat.id = p.category_id',
    group: 'cat.id, cat.name', label: "COALESCE(cat.name,'(sin categoría)')",
  },
  warehouse: {
    join: 'LEFT JOIN commercial.warehouses w ON w.id = s.warehouse_id',
    group: 'w.code, w.name', label: "COALESCE(w.name, w.code, '(sin almacén)')",
  },
  channel: { join: '', group: 's.channel', label: "COALESCE(s.channel,'(sin canal)')" },
  day: { join: '', group: 's.sale_date', label: "to_char(s.sale_date,'YYYY-MM-DD')", time: true },
  month: { join: '', group: "date_trunc('month', s.sale_date)", label: "to_char(date_trunc('month', s.sale_date),'YYYY-MM')", time: true },
};

@Injectable()
export class ThotToolsService implements ThotToolProvider {
  private readonly logger = new Logger(ThotToolsService.name);

  constructor(
    private readonly analytics: CommercialAnalyticsService,
    private readonly thot: ThotService,
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  /** Perfil admin: acceso completo al tenant (back-office). */
  systemPrompt(scope: ThotScope, ctx: { today: string }): string {
    return buildThotSystemPrompt({ today: ctx.today, userName: scope.userName || undefined });
  }

  // ── Schema para Claude ───────────────────────────────────────────────
  definitions(_scope?: ThotScope): ThotToolDef[] {
    const dateRange = {
      from: { type: 'string', description: 'Fecha inicio ISO (YYYY-MM-DD). Opcional.' },
      to: { type: 'string', description: 'Fecha fin ISO (YYYY-MM-DD). Opcional.' },
    };
    return [
      {
        name: 'thot_resolve_entity',
        description:
          'Resuelve un nombre difuso a su id/código. ÚSALA PRIMERO cuando el usuario menciona un producto, marca, cliente o almacén por nombre, antes de pasar el id a otra tool.',
        input_schema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Texto a buscar (nombre/parte del nombre o SKU/código).' },
            kind: { type: 'string', enum: ['product', 'brand', 'customer', 'warehouse', 'all'], description: 'Tipo de entidad. Default all.' },
          },
          required: ['text'],
        },
      },
      {
        name: 'thot_list_warehouses',
        description: 'Lista los almacenes (id, código, nombre). Útil para saber qué almacenes existen o conseguir un warehouse id.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'thot_sales_timeseries',
        description: 'VENTA REAL del ERP por día (revenue, unidades, tickets). Para "cuánto se vendió", tendencias, totales por período. Opcional filtrar por zona/almacén.',
        input_schema: { type: 'object', properties: { ...dateRange, zona: { type: 'string', description: 'Nombre o código de almacén/zona. Opcional.' } } },
      },
      {
        name: 'thot_top_products',
        description: 'VENTA REAL del ERP: productos más vendidos por revenue en el período (con categoría y marca). Para "qué se vende más".',
        input_schema: { type: 'object', properties: { ...dateRange, zona: { type: 'string' }, limit: { type: 'number', description: 'Default 20, máx 100.' } } },
      },
      {
        name: 'thot_product_ranking',
        description: 'VENTA REAL del ERP: ranking de best-sellers de los últimos 365 días (revenue y piezas). Ranking estable de largo plazo.',
        input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Default 100, máx 1000.' } } },
      },
      {
        name: 'thot_sales_by_zone',
        description: 'VENTA REAL del ERP agregada por zona/almacén (revenue, unidades, tickets) en el período.',
        input_schema: { type: 'object', properties: { ...dateRange } },
      },
      {
        name: 'thot_margin_by_category',
        description: 'VENTA REAL del ERP: margen ($ y %) por categoría de producto en el período. Para rentabilidad por categoría.',
        input_schema: { type: 'object', properties: { ...dateRange, limit: { type: 'number', description: 'Default 30, máx 100.' } } },
      },
      {
        name: 'thot_flexible_aggregate',
        description:
          'Agregación flexible de VENTA REAL del ERP. Para preguntas que no cubren las otras tools: elige una métrica y una dimensión para agrupar. Ej: revenue por brand, units por month, tickets por warehouse.',
        input_schema: {
          type: 'object',
          properties: {
            metric: { type: 'string', enum: ['revenue', 'units', 'tickets'], description: 'Qué sumar.' },
            group_by: { type: 'string', enum: ['product', 'brand', 'category', 'warehouse', 'channel', 'day', 'month'], description: 'Cómo agrupar.' },
            ...dateRange,
            limit: { type: 'number', description: 'Default 25, máx 200.' },
          },
          required: ['metric', 'group_by'],
        },
      },
      {
        name: 'thot_inventory_health',
        description: 'Salud de inventario: días de cobertura y status (agotado/critico/sano/sobrestock/muerto/nuevo) por producto×almacén. Opcional filtrar por almacén o status.',
        input_schema: { type: 'object', properties: { warehouse_id: { type: 'string', description: 'UUID de almacén. Opcional.' }, status: { type: 'string', enum: ['agotado', 'critico', 'sano', 'sobrestock', 'muerto', 'nuevo'] } } },
      },
      {
        name: 'thot_dead_stock',
        description: 'Stock muerto: existencia > 0 sin venta en 90 días (capital parado al costo). Opcional por almacén.',
        input_schema: { type: 'object', properties: { warehouse_id: { type: 'string' }, limit: { type: 'number', description: 'Default 500, máx 2000.' } } },
      },
      {
        name: 'thot_low_stock',
        description: 'Productos con disponible (existencia − reservado) por debajo de un umbral. Alertas de reposición.',
        input_schema: { type: 'object', properties: { threshold: { type: 'number', description: 'Umbral, default 10.' }, warehouse_id: { type: 'string' }, limit: { type: 'number' } } },
      },
      {
        name: 'thot_out_of_stock_bestsellers',
        description: 'Best-sellers del ERP con disponible 0 en la app (venta perdida). Señal crítica de reposición.',
        input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Default 10, máx 50.' } } },
      },
      {
        name: 'thot_active_promotions',
        description: 'Promociones vigentes del ERP (descuento/gratis por volumen) por producto.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'thot_erp_customers',
        description: 'Clientes del ERP Kepler con su compra agregada (180 días): revenue, # productos, última compra. Opcional buscar por nombre.',
        input_schema: { type: 'object', properties: { search: { type: 'string', description: 'Filtro por nombre. Opcional.' }, limit: { type: 'number', description: 'Default 100, máx 500.' } } },
      },
      {
        name: 'thot_customer_products',
        description: 'Qué productos compró un cliente del ERP (ventanas 90/180 días). Requiere el erp_code (consíguelo con thot_erp_customers o thot_resolve_entity).',
        input_schema: { type: 'object', properties: { erp_code: { type: 'string', description: 'Código ERP del cliente.' } }, required: ['erp_code'] },
      },
      {
        name: 'thot_get_sales_overview',
        description: 'PIPELINE B2B de la app (pedidos levantados en portal/vendedor, volumen chico en beta): revenue, # pedidos, AOV, clientes únicos. NO es la venta real del ERP.',
        input_schema: { type: 'object', properties: { ...dateRange } },
      },
      {
        name: 'thot_top_customers',
        description: 'PIPELINE B2B de la app: clientes top por revenue de pedidos levantados en la app. NO es la venta real del ERP (para eso usá thot_erp_customers).',
        input_schema: { type: 'object', properties: { ...dateRange, limit: { type: 'number', description: 'Default 10, máx 100.' } } },
      },
      {
        name: 'thot_inactive_customers',
        description: 'PIPELINE B2B de la app: clientes sin pedido en N días (riesgo de churn / recuperación).',
        input_schema: { type: 'object', properties: { days: { type: 'number', description: 'Default 30.' }, limit: { type: 'number', description: 'Default 50.' } } },
      },
      {
        name: 'thot_sales_by_brand',
        description: 'PIPELINE B2B de la app: revenue y share % por marca de pedidos de la app. Para marca sobre VENTA REAL usá thot_flexible_aggregate (metric=revenue, group_by=brand).',
        input_schema: { type: 'object', properties: { ...dateRange } },
      },
      {
        name: 'thot_suggest',
        description: 'Recomendación del motor Thot para un cliente: qué productos empujarle y por qué (rotación/margen/afinidad/zona/whitespace/promo). Requiere customer_id (UUID de commercial.customers; resolvelo con thot_resolve_entity kind=customer).',
        input_schema: { type: 'object', properties: { customer_id: { type: 'string', description: 'UUID del cliente B2B.' }, limit: { type: 'number', description: 'Default 12, máx 50.' } }, required: ['customer_id'] },
      },
    ];
  }

  // ── Ejecución ────────────────────────────────────────────────────────
  async execute(name: string, input: any, _scope?: ThotScope): Promise<any> {
    const args = input || {};
    try {
      switch (name) {
        case 'thot_resolve_entity':
          return await this.resolveEntity(String(args.text || ''), args.kind || 'all');
        case 'thot_list_warehouses':
          return await this.listWarehouses();
        case 'thot_sales_timeseries':
          return this.cap(await this.analytics.historicalSalesDaily({ from: args.from, to: args.to, zona: args.zona }));
        case 'thot_top_products':
          return await this.analytics.historicalTopProducts({ from: args.from, to: args.to, zona: args.zona, limit: args.limit });
        case 'thot_product_ranking':
          return await this.analytics.historicalRanking({ limit: args.limit });
        case 'thot_sales_by_zone':
          return await this.analytics.historicalSalesByZona({ from: args.from, to: args.to });
        case 'thot_margin_by_category':
          return await this.analytics.historicalMarginByCategory({ from: args.from, to: args.to, limit: args.limit });
        case 'thot_flexible_aggregate':
          return await this.flexibleAggregate(args);
        case 'thot_inventory_health':
          return await this.analytics.inventoryHealth({ warehouse_id: args.warehouse_id, status: args.status });
        case 'thot_dead_stock':
          return await this.analytics.deadStock(args.warehouse_id, args.limit);
        case 'thot_low_stock':
          return await this.analytics.lowStock(args.threshold, args.warehouse_id, args.limit);
        case 'thot_out_of_stock_bestsellers':
          return await this.analytics.rankingOutOfStock({ limit: args.limit });
        case 'thot_active_promotions':
          return await this.analytics.erpPromotions();
        case 'thot_erp_customers':
          return await this.analytics.erpCustomers({ search: args.search, limit: args.limit });
        case 'thot_customer_products':
          if (!args.erp_code) return { error: 'Falta erp_code. Usá thot_erp_customers o thot_resolve_entity para obtenerlo.' };
          return await this.analytics.erpCustomerProducts(String(args.erp_code));
        case 'thot_get_sales_overview':
          return await this.analytics.overview({ from: args.from, to: args.to });
        case 'thot_top_customers':
          return await this.analytics.topCustomers({ from: args.from, to: args.to, limit: args.limit });
        case 'thot_inactive_customers':
          return await this.analytics.inactiveCustomers(args.days, args.limit);
        case 'thot_sales_by_brand':
          return await this.analytics.salesByBrand({ from: args.from, to: args.to });
        case 'thot_suggest':
          if (!UUID_RE.test(String(args.customer_id || ''))) return { error: 'customer_id debe ser un UUID. Resolvelo con thot_resolve_entity kind=customer.' };
          return await this.thot.suggest(String(args.customer_id), { limit: args.limit });
        default:
          return { error: `Tool desconocida: ${name}` };
      }
    } catch (e: any) {
      this.logger.warn(`Tool ${name} falló: ${e?.message || e}`);
      return { error: `La tool ${name} falló: ${e?.message || 'error'}. Probá con otros parámetros o decí que no hay datos.` };
    }
  }

  /** Trunca arrays grandes para no inflar el contexto del LLM. */
  private cap<T>(rows: T, max = 200): T {
    if (Array.isArray(rows) && rows.length > max) {
      return [...(rows as any[]).slice(0, max), { _truncated: `+${rows.length - max} filas omitidas` }] as any;
    }
    return rows;
  }

  // ── resolve_entity: RAG ligero por ILIKE sobre catálogo/clientes ──────
  private async resolveEntity(text: string, kind: string) {
    const q = text.trim();
    if (q.length < 2) return { error: 'Texto muy corto para buscar (mínimo 2 caracteres).' };
    const tenantId = this.ctx.requireTenantId();
    const like = `%${q}%`;
    return this.tk.run(async (trx) => {
      const out: any = {};
      if (kind === 'product' || kind === 'all') {
        out.products = await trx('catalog.products as p')
          .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
          .where('p.tenant_id', tenantId)
          .whereNull('p.deleted_at')
          .andWhere((w: any) => w.whereRaw('p.nombre ILIKE ?', [like]).orWhereRaw('p.sku ILIKE ?', [like]))
          .select('p.id', 'p.sku', 'p.nombre', 'b.nombre as brand_name')
          .limit(8);
      }
      if (kind === 'brand' || kind === 'all') {
        out.brands = await trx('catalog.brands')
          .where('tenant_id', tenantId)
          .whereRaw('nombre ILIKE ?', [like])
          .select('id', 'nombre')
          .limit(8);
      }
      if (kind === 'warehouse' || kind === 'all') {
        out.warehouses = await trx('commercial.warehouses')
          .where('tenant_id', tenantId)
          .whereNull('deleted_at')
          .andWhere((w: any) => w.whereRaw('name ILIKE ?', [like]).orWhereRaw('code ILIKE ?', [like]))
          .select('id', 'code', 'name')
          .limit(15);
      }
      if (kind === 'customer' || kind === 'all') {
        out.customers_b2b = await trx('commercial.customers')
          .where('tenant_id', tenantId)
          .whereNull('deleted_at')
          .andWhere((w: any) => w.whereRaw('name ILIKE ?', [like]).orWhereRaw('code ILIKE ?', [like]))
          .select('id', 'code', 'name')
          .limit(8);
        out.customers_erp = await trx('analytics.erp_customers')
          .where('tenant_id', tenantId)
          .whereRaw('name ILIKE ?', [like])
          .select('erp_code', 'name', 'city')
          .limit(8);
      }
      return out;
    });
  }

  private async listWarehouses() {
    const tenantId = this.ctx.requireTenantId();
    return this.tk.run(async (trx) =>
      trx('commercial.warehouses')
        .where('tenant_id', tenantId)
        .whereNull('deleted_at')
        .select('id', 'code', 'name')
        .orderBy('code', 'asc'),
    );
  }

  // ── flexible_aggregate: escape hatch (whitelist, sin SQL libre) ───────
  private async flexibleAggregate(args: any) {
    const metric = FLEX_METRICS[args.metric];
    const dim = FLEX_DIMS[args.group_by];
    if (!metric) return { error: `metric inválida. Permitidas: ${Object.keys(FLEX_METRICS).join(', ')}.` };
    if (!dim) return { error: `group_by inválido. Permitidos: ${Object.keys(FLEX_DIMS).join(', ')}.` };
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 25));
    const tenantId = this.ctx.requireTenantId();
    const from = args.from && !Number.isNaN(Date.parse(args.from)) ? args.from : null;
    const to = args.to && !Number.isNaN(Date.parse(args.to)) ? args.to : null;
    const order = dim.time ? `${dim.group} ASC` : 'value DESC NULLS LAST';

    return this.tk.run(async (trx) => {
      const res = await trx.raw(
        `SELECT ${dim.label} AS label, ${metric}::numeric AS value
         FROM analytics.sales_daily s ${dim.join}
         WHERE s.tenant_id = ?
           ${from ? 'AND s.sale_date >= ?' : ''}
           ${to ? 'AND s.sale_date <= ?' : ''}
         GROUP BY ${dim.group}
         ORDER BY ${order}
         LIMIT ?`,
        [tenantId, ...(from ? [from] : []), ...(to ? [to] : []), limit],
      );
      return {
        metric: args.metric,
        group_by: args.group_by,
        period: { from, to },
        source: 'venta real ERP (analytics.sales_daily)',
        rows: res.rows.map((r: any) => ({ label: r.label, value: Number(r.value) })),
      };
    });
  }
}
