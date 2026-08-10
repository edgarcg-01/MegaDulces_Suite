import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CommercialAnalyticsService } from '../../commercial-analytics/commercial-analytics.service';
import { RoutePromoService } from '../../commercial-analytics/route-promo.service';
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
  week: { join: '', group: "date_trunc('week', s.sale_date)", label: "to_char(date_trunc('week', s.sale_date),'IYYY-\"W\"IW')", time: true },
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
    private readonly promo: RoutePromoService,
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
            group_by: { type: 'string', enum: ['product', 'brand', 'category', 'warehouse', 'channel', 'day', 'week', 'month'], description: 'Cómo agrupar. week = semana ISO (ej 2026-W27).' },
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
        name: 'thot_shipments',
        description: 'VENTA REAL — embarques/reparto del ERP (kdpord) agregados: folios, unidades por ruta/estado/almacén/día/producto. Para "cuánto se embarcó", "entregas por ruta", "% embarcado".',
        input_schema: { type: 'object', properties: { group_by: { type: 'string', enum: ['route', 'status', 'warehouse', 'day', 'product'], description: 'Cómo agrupar. Default route.' }, ...dateRange, route: { type: 'string' }, status: { type: 'string' } } },
      },
      {
        name: 'thot_sales_by_vendor',
        description:
          'VENTA REAL del ERP por VENDEDOR (revenue, tickets, share %). Para "ventas por vendedor", "quién vende más", el desempeño de un vendedor o de una ruta vecinal (los vendedores de ruta aparecen acá). Rango de MESES opcional (from/to = "YYYY-MM"); default últimos 6 meses. Opcional filtrar por almacén (código o nombre) o por vendedor.',
        input_schema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Mes inicio "YYYY-MM". Opcional (default: hace 6 meses).' },
            to: { type: 'string', description: 'Mes fin "YYYY-MM". Opcional (default: mes actual).' },
            warehouse: { type: 'string', description: 'Código o nombre de almacén/sucursal. Opcional.' },
            vendor: { type: 'string', description: 'Nombre o código de vendedor a filtrar. Opcional.' },
            limit: { type: 'number', description: 'Default 25, máx 100.' },
          },
        },
      },
      {
        name: 'thot_sales_by_route',
        description:
          'VENTA REAL del ERP por RUTA de venta (revenue, tickets, share %). Para "ventas por ruta", "qué % representa la ruta X". La RUTA VECINAL PH aparece con código WIN-VEC-PH-*. Rango de MESES opcional (from/to = "YYYY-MM"); default últimos 6 meses.',
        input_schema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Mes inicio "YYYY-MM". Opcional (default: hace 6 meses).' },
            to: { type: 'string', description: 'Mes fin "YYYY-MM". Opcional (default: mes actual).' },
            limit: { type: 'number', description: 'Default 50, máx 100.' },
          },
        },
      },
      {
        name: 'thot_incentivo',
        description:
          'Calcula el PAGO de una MECÁNICA DE INCENTIVO/PROMO al equipo de campo, sobre venta real. Úsala cuando el usuario describe una promo con reglas del tipo: "$X por cada venta/pieza/cliente del producto Y". Vos (el asistente) interpretás el enunciado y pasás los parámetros; esta tool hace SOLO la aritmética determinista sobre la venta real. Reglas de interpretación:\n' +
          '• "clientes distintos a los que se vendió una o más piezas" / "por cliente que compre" → metric=clientes_distintos, min_qty=1 (cada cliente cuenta UNA vez sin importar piezas).\n' +
          '• "por cada pieza/unidad vendida" → metric=piezas. "por ticket/venta" → metric=tickets. "% o $ sobre venta" → metric=monto.\n' +
          '• RD / reparto / venta a bordo → canal=ruta. Mayoreo/crédito → canal=mayoreo. Mostrador → canal=mostrador. Preventa/vecinal → canal=preventa. Si no dice canal → canal=todos.\n' +
          '• dimension = cómo desglosar el pago: por "vendedor" (default, es a quien se le paga), "ruta", "sucursal" o "canal" — elegila según lo que pida el enunciado.\n' +
          'Resolvé el producto a SKU con thot_resolve_entity ANTES si el enunciado lo menciona por nombre; pasá ese sku. Devuelve el pago por dimensión + total.',
        input_schema: {
          type: 'object',
          properties: {
            sku: { type: 'string', description: 'SKU exacto del producto de la promo (resolvelo antes con thot_resolve_entity si viene por nombre).' },
            producto_texto: { type: 'string', description: 'Nombre del producto si no tenés el SKU (se resuelve por catálogo). Preferí sku.' },
            metric: { type: 'string', enum: ['clientes_distintos', 'piezas', 'tickets', 'monto'], description: 'Qué se paga.' },
            rate: { type: 'number', description: 'Monto en pesos por cada unidad de la métrica (ej $6.00 → 6).' },
            min_qty: { type: 'number', description: 'Piezas mínimas por cliente para calificar (default 1). Solo aplica a clientes_distintos.' },
            canal: { type: 'string', enum: ['ruta', 'mayoreo', 'mostrador', 'preventa', 'todos'], description: 'Canal al que aplica la promo. Default todos.' },
            dimension: { type: 'string', enum: ['vendedor', 'ruta', 'canal', 'sucursal'], description: 'Cómo desglosar el pago. Default vendedor.' },
            from: { type: 'string', description: 'Fecha inicio ISO (YYYY-MM-DD). Opcional (default: mes anterior).' },
            to: { type: 'string', description: 'Fecha fin ISO (YYYY-MM-DD). Opcional.' },
          },
          required: ['metric', 'rate'],
        },
      },
      {
        name: 'thot_reorder_policy',
        description:
          'Política de reabastecimiento por SKU: MÍNIMO, punto de reorden y MÁXIMO por almacén (en piezas) + existencia disponible actual + clase ABC/XYZ. Para "cuál es el máximo del SKU X", "punto de orden", "cuánto debo tener de Y". Pasá sku (exacto) o query (nombre); opcional filtrar por almacén.',
        input_schema: {
          type: 'object',
          properties: {
            sku: { type: 'string', description: 'SKU exacto del producto.' },
            query: { type: 'string', description: 'Nombre (o parte) del producto, si no tenés el SKU.' },
            warehouse: { type: 'string', description: 'Código o nombre de almacén. Opcional (default: todos).' },
          },
        },
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
      {
        name: 'thot_remember',
        description:
          'Guarda un HECHO durable que el usuario te enseña, para RECORDARLO en futuras conversaciones (ej: "Candelares Salgado es vendedora vecinal de la ruta PH 01"). Usalo cuando el usuario te dé un dato de negocio que deberías retener (quién es alguien, cómo se llama algo, una convención interna). title = clave corta; body = el hecho. Si el title ya existe, lo actualiza.',
        input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Clave corta del hecho (ej: "Vendedora Candelares Salgado").' }, body: { type: 'string', description: 'El hecho completo, en texto.' } }, required: ['title', 'body'] },
      },
      {
        name: 'thot_forget',
        description: 'Olvida (borra) un hecho que habías guardado con thot_remember. Pasá el title exacto de la nota.',
        input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Title exacto de la nota a olvidar.' } }, required: ['title'] },
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
        case 'thot_shipments':
          return await this.analytics.erpShipments({ group_by: args.group_by, from: args.from, to: args.to, route: args.route, status: args.status });
        case 'thot_sales_by_vendor':
          return await this.salesByVendor(args);
        case 'thot_sales_by_route':
          return await this.salesByRoute(args);
        case 'thot_reorder_policy':
          return await this.reorderPolicy(args);
        case 'thot_incentivo':
          return await this.promo.evaluateIncentive({
            sku: args.sku, producto_texto: args.producto_texto,
            metric: args.metric, rate: args.rate, min_qty: args.min_qty,
            canal: args.canal, dimension: args.dimension, from: args.from, to: args.to,
          });
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
        case 'thot_remember':
          return await this.remember(args, _scope);
        case 'thot_forget':
          return await this.forget(args);
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
      // % determinista (NUNCA dejar que el LLM divida de cabeza). El total es el
      // de las filas devueltas; si hubo LIMIT, total_is_partial avisa.
      const rows = res.rows.map((r: any) => ({ label: r.label, value: Number(r.value) }));
      const total = rows.reduce((s: number, r: any) => s + (r.value || 0), 0);
      const withShare = rows.map((r: any) => ({
        ...r,
        share_pct: total > 0 && !dim.time ? +((r.value / total) * 100).toFixed(1) : null,
      }));
      return {
        metric: args.metric,
        group_by: args.group_by,
        period: { from, to },
        source: 'venta real ERP (analytics.sales_daily)',
        total: +total.toFixed(2),
        total_is_partial: rows.length >= limit,
        rows: withShare,
      };
    });
  }

  // ── venta real por VENDEDOR (analytics.sales_by_vendor_monthly) ───────
  private async salesByVendor(args: any) {
    const tenantId = this.ctx.requireTenantId();
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
    const fromM = /^\d{4}-\d{2}$/.test((args.from || '').trim()) ? String(args.from).trim() : null;
    const toM = /^\d{4}-\d{2}$/.test((args.to || '').trim()) ? String(args.to).trim() : null;
    const wh = String(args.warehouse || '').trim();
    const vendor = String(args.vendor || '').trim();
    const params: any[] = [tenantId];
    let sql = `SELECT v.vendor_code, v.vendor_name,
                 COALESCE(SUM(v.revenue),0)::numeric AS revenue,
                 COALESCE(SUM(v.tickets),0)::bigint AS tickets
               FROM analytics.sales_by_vendor_monthly v`;
    if (wh) sql += ` LEFT JOIN commercial.warehouses w ON w.id = v.warehouse_id`;
    sql += ` WHERE v.tenant_id = ?`;
    if (fromM) { sql += ` AND v.year_month >= ?`; params.push(fromM); }
    else sql += ` AND v.year_month >= to_char((current_date - interval '5 months'), 'YYYY-MM')`;
    if (toM) { sql += ` AND v.year_month <= ?`; params.push(toM); }
    else sql += ` AND v.year_month <= to_char(current_date, 'YYYY-MM')`;
    if (wh) { sql += ` AND (w.code ILIKE ? OR w.name ILIKE ?)`; params.push(wh, `%${wh}%`); }
    if (vendor) { sql += ` AND (v.vendor_name ILIKE ? OR v.vendor_code ILIKE ?)`; params.push(`%${vendor}%`, `%${vendor}%`); }
    sql += ` GROUP BY v.vendor_code, v.vendor_name ORDER BY revenue DESC LIMIT ?`;
    params.push(limit);
    return this.tk.run(async (trx) => {
      const res = await trx.raw(sql, params);
      const rows = res.rows.map((r: any) => ({ vendor_code: r.vendor_code, vendor_name: r.vendor_name, revenue: Number(r.revenue), tickets: Number(r.tickets) }));
      const total = rows.reduce((s: number, r: any) => s + (r.revenue || 0), 0);
      return {
        source: 'venta real ERP (analytics.sales_by_vendor_monthly)',
        period: { from: fromM || '(últimos 6 meses)', to: toM || '(mes actual)' },
        warehouse: wh || 'todos',
        total_revenue: +total.toFixed(2),
        total_is_partial: rows.length >= limit,
        rows: rows.map((r: any) => ({ ...r, share_pct: total > 0 ? +((r.revenue / total) * 100).toFixed(1) : null })),
      };
    });
  }

  // ── venta real por RUTA (analytics.sales_by_route_monthly) ────────────
  private async salesByRoute(args: any) {
    const tenantId = this.ctx.requireTenantId();
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
    const norm = (s: any) => {
      s = String(s || '').trim();
      if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      return null;
    };
    const from = norm(args.from);
    const to = norm(args.to);
    const params: any[] = [tenantId];
    let sql = `SELECT route_code, route_no,
                 COALESCE(SUM(revenue),0)::numeric AS revenue,
                 COALESCE(SUM(tickets),0)::bigint AS tickets
               FROM analytics.sales_by_route_monthly
               WHERE tenant_id = ?`;
    if (from) { sql += ` AND month >= ?::date`; params.push(from); }
    else sql += ` AND month >= date_trunc('month', current_date - interval '5 months')`;
    if (to) { sql += ` AND month <= ?::date`; params.push(to); }
    else sql += ` AND month <= date_trunc('month', current_date)`;
    sql += ` GROUP BY route_code, route_no ORDER BY revenue DESC LIMIT ?`;
    params.push(limit);
    return this.tk.run(async (trx) => {
      const res = await trx.raw(sql, params);
      const rows = res.rows.map((r: any) => ({ route_code: r.route_code, route_no: r.route_no, revenue: Number(r.revenue), tickets: Number(r.tickets) }));
      const total = rows.reduce((s: number, r: any) => s + (r.revenue || 0), 0);
      return {
        source: 'venta real ERP (analytics.sales_by_route_monthly)',
        period: { from: from || '(últimos 6 meses)', to: to || '(mes actual)' },
        total_revenue: +total.toFixed(2),
        total_is_partial: rows.length >= limit,
        rows: rows.map((r: any) => ({ ...r, share_pct: total > 0 ? +((r.revenue / total) * 100).toFixed(1) : null })),
      };
    });
  }

  // ── política de reabastecimiento por SKU (commercial.reorder_policy) ──
  private async reorderPolicy(args: any) {
    const tenantId = this.ctx.requireTenantId();
    const sku = String(args.sku || '').trim();
    const query = String(args.query || '').trim();
    const wh = String(args.warehouse || '').trim();
    if (!sku && !query) return { error: 'Indicá un SKU (sku) o un texto de búsqueda (query) del producto.' };
    return this.tk.run(async (trx) => {
      let prodQ = trx('catalog.products as p').where('p.tenant_id', tenantId).whereNull('p.deleted_at');
      if (sku) prodQ = prodQ.where('p.sku', sku);
      else prodQ = prodQ.andWhere((w: any) => w.whereRaw('p.nombre ILIKE ?', [`%${query}%`]).orWhereRaw('p.sku ILIKE ?', [`%${query}%`]));
      const prods = await prodQ.select('p.id', 'p.sku', 'p.nombre').limit(8);
      if (!prods.length) return { error: `No encontré producto con ${sku ? 'SKU ' + sku : 'texto "' + query + '"'}.` };
      if (prods.length > 1 && !sku) return { disambiguate: prods, note: 'Varios productos coinciden; pasá el SKU exacto.' };
      const ids = prods.map((p: any) => p.id);
      let rpQ = trx('commercial.reorder_policy as rp')
        .join('catalog.products as p', 'p.id', 'rp.product_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'rp.warehouse_id')
        .where('rp.tenant_id', tenantId)
        .whereIn('rp.product_id', ids);
      if (wh) rpQ = rpQ.andWhere((b: any) => b.whereRaw('w.code ILIKE ?', [wh]).orWhereRaw('w.name ILIKE ?', [`%${wh}%`]));
      const rows = await rpQ
        .select(
          'p.sku',
          'p.nombre',
          trx.raw('COALESCE(w.code, rp.warehouse_id::text) AS warehouse'),
          'w.name AS warehouse_name',
          'rp.min_stock',
          'rp.reorder_point',
          'rp.max_stock',
          trx.raw(
            `(SELECT COALESCE(SUM(st.quantity),0) - COALESCE(SUM(st.reserved_quantity),0)
               FROM commercial.stock st
               WHERE st.tenant_id = rp.tenant_id AND st.product_id = rp.product_id AND st.warehouse_id = rp.warehouse_id) AS available`,
          ),
          'rp.abc_class',
          'rp.xyz_class',
          'rp.source',
        )
        .orderBy('p.sku')
        .orderByRaw('w.code ASC NULLS LAST')
        .limit(200);
      return {
        source: 'commercial.reorder_policy + commercial.stock (piezas)',
        note: 'min_stock / reorder_point / max_stock en PIEZAS. available = existencia − reservado (suma de pasillos).',
        count: rows.length,
        rows,
      };
    });
  }

  // ── memoria: hechos que el usuario le enseña a Thot (commercial.thot_notes) ──
  private async remember(args: any, scope?: ThotScope) {
    const title = String(args.title || '').trim();
    const body = String(args.body || '').trim();
    if (!title || !body) return { error: 'Faltan title y body para guardar la nota.' };
    const tenantId = this.ctx.requireTenantId();
    return this.tk.run(async (trx) => {
      await trx.raw(
        `INSERT INTO commercial.thot_notes (tenant_id, title, body, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, title) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
        [tenantId, title.slice(0, 200), body.slice(0, 2000), scope?.userName || null],
      );
      return { ok: true, saved: title, note: 'Guardado. Lo voy a recordar en próximas conversaciones.' };
    });
  }

  private async forget(args: any) {
    const title = String(args.title || '').trim();
    if (!title) return { error: 'Falta el title de la nota a olvidar.' };
    const tenantId = this.ctx.requireTenantId();
    return this.tk.run(async (trx) => {
      const n = await trx('commercial.thot_notes').where({ tenant_id: tenantId, title }).del();
      return n ? { ok: true, forgotten: title } : { ok: false, note: `No tenía guardada una nota con title "${title}".` };
    });
  }
}
