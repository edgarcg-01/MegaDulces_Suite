import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { ThotService } from '../thot.service';
import { Customer360Service } from '../customer-360.service';
import { ThotToolDef, ThotToolProvider, ThotScope } from './thot-tool-provider';
import { buildVendorSystemPrompt } from './thot-semantic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * TC-V (ADR-026) — Tools del vendedor. Clientes scoped a su CARTERA (rutas
 * asignadas en trade). Stock/disponibilidad desde el almacén de surtido (PH).
 * Márgenes permitidos (rol interno). El vendorUserId viene del JWT (server-side).
 */
@Injectable()
export class VendorThotToolsService implements ThotToolProvider {
  private readonly logger = new Logger(VendorThotToolsService.name);

  constructor(
    private readonly thot: ThotService,
    private readonly customer360: Customer360Service,
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  systemPrompt(scope: ThotScope, ctx: { today: string }): string {
    return buildVendorSystemPrompt({ today: ctx.today, userName: scope.userName || undefined });
  }

  /** Predicado: el cliente pertenece a la cartera del vendedor (cualquier ruta asignada). */
  private carteraSql(alias = 'c'): string {
    return `EXISTS (
      SELECT 1 FROM public.daily_assignments da
      JOIN public.catalogs cat ON cat.id = da.route_id AND cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
      WHERE da.user_id = ? AND cat.value = ${alias}.sales_route
    )`;
  }

  definitions(_scope: ThotScope): ThotToolDef[] {
    return [
      { name: 'thot_find_customer', description: 'Busca un cliente DE TU CARTERA por nombre o código. Úsala primero para obtener el id antes de consultar su 360/historial/sugeridos.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'thot_customer_360', description: 'Perfil 360 de un cliente de tu cartera (cadencia, recencia, etapa, RFM). Requiere customer_id.', input_schema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } },
      { name: 'thot_customer_history', description: 'Qué compra habitualmente un cliente de tu cartera + sus últimos pedidos. Requiere customer_id.', input_schema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } },
      { name: 'thot_suggest_for_customer', description: 'Qué ofrecerle a un cliente (recomendación del motor: rotación/margen/afinidad/zona/whitespace/promo). Requiere customer_id.', input_schema: { type: 'object', properties: { customer_id: { type: 'string' }, limit: { type: 'number', description: 'Default 12.' } }, required: ['customer_id'] } },
      { name: 'thot_my_today', description: 'Resumen de tu día: clientes de la cartera de hoy, cuántos visitaste y a cuántos ya les tomaste pedido.', input_schema: { type: 'object', properties: {} } },
      { name: 'thot_inactive_customers', description: 'Clientes de tu cartera que llevan N días sin comprar (oportunidad de recuperación).', input_schema: { type: 'object', properties: { days: { type: 'number', description: 'Default 30.' } } } },
      { name: 'thot_product_stock', description: 'Stock disponible de un producto en el almacén que te surte (PH). Para "¿hay X para surtir?".', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ];
  }

  async execute(name: string, input: any, scope: ThotScope): Promise<any> {
    const args = input || {};
    const vendor = scope.vendorUserId || this.ctx.get()?.userId;
    if (!vendor) return { error: 'No hay vendedor en el contexto.' };
    try {
      switch (name) {
        case 'thot_find_customer':
          return await this.findCustomer(vendor, String(args.query || ''));
        case 'thot_customer_360':
          return await this.guarded(vendor, args.customer_id, () => this.customer360.getForCustomer(String(args.customer_id)));
        case 'thot_customer_history':
          return await this.guarded(vendor, args.customer_id, () => this.customerHistory(String(args.customer_id)));
        case 'thot_suggest_for_customer':
          return await this.guarded(vendor, args.customer_id, async () => {
            const rows = await this.thot.suggest(String(args.customer_id), { limit: Math.min(20, Math.max(1, Number(args.limit) || 12)) });
            return rows.map((r) => ({ product: r.product_name, price: r.price, margin_pct: r.margin_pct, reason: r.reason_label, present: r.present }));
          });
        case 'thot_my_today':
          return await this.myToday(vendor);
        case 'thot_inactive_customers':
          return await this.inactive(vendor, args.days);
        case 'thot_product_stock':
          return await this.productStock(String(args.query || ''), scope.warehouseCode);
        default:
          return { error: `Tool no disponible para vendedor: ${name}` };
      }
    } catch (e: any) {
      this.logger.warn(`Vendor tool ${name} falló: ${e?.message || e}`);
      return { error: `No pude consultar eso ahora (${name}).` };
    }
  }

  /** Valida que el cliente sea de la cartera antes de ejecutar fn. */
  private async guarded(vendor: string, customerId: any, fn: () => Promise<any>): Promise<any> {
    if (!UUID_RE.test(String(customerId || ''))) return { error: 'customer_id inválido. Buscalo con thot_find_customer.' };
    const ok = await this.tk.run(async (trx) => {
      const row = await trx('commercial.customers as c')
        .where('c.id', customerId).whereNull('c.deleted_at')
        .andWhereRaw(this.carteraSql('c'), [vendor])
        .first('c.id');
      return !!row;
    });
    if (!ok) return { error: 'Ese cliente no está en tu cartera.' };
    return fn();
  }

  private async findCustomer(vendor: string, query: string) {
    const q = query.trim();
    if (q.length < 2) return { error: 'Escribí al menos 2 caracteres.' };
    const like = `%${q}%`;
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.customers as c')
        .whereNull('c.deleted_at')
        .andWhereRaw(this.carteraSql('c'), [vendor])
        .andWhere((w: any) => w.whereRaw('c.name ILIKE ?', [like]).orWhereRaw('c.code ILIKE ?', [like]))
        .limit(10)
        .select('c.id', 'c.code', 'c.name', 'c.sales_route');
      return rows.length ? rows : { message: `No encontré "${q}" en tu cartera.` };
    });
  }

  private async customerHistory(customerId: string) {
    return this.tk.run(async (trx) => {
      const orders = await trx('commercial.orders')
        .where({ customer_id: customerId }).whereNull('deleted_at')
        .orderBy('created_at', 'desc').limit(8)
        .select('code', 'status', 'total', 'created_at');
      const usual = await trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .join('catalog.products as p', 'p.id', 'ol.product_id')
        .where('o.customer_id', customerId).whereIn('o.status', ['confirmed', 'fulfilled'])
        .groupBy('p.nombre').orderByRaw('SUM(ol.quantity) DESC').limit(15)
        .select('p.nombre as product', trx.raw('SUM(ol.quantity)::numeric AS units'));
      return {
        recent_orders: orders.map((o: any) => ({ folio: o.code, status: o.status, total: Number(o.total), date: o.created_at })),
        usual_products: usual.map((u: any) => ({ product: u.product, units: Number(u.units) })),
      };
    });
  }

  private async myToday(vendor: string) {
    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.customers as c')
        .whereNull('c.deleted_at')
        .andWhereRaw(`(
          c.visit_days IS NULL OR cardinality(c.visit_days) = 0
          OR c.visit_days @> ARRAY[EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::smallint]
        ) AND EXISTS (
          SELECT 1 FROM public.daily_assignments da
          JOIN public.catalogs cat ON cat.id = da.route_id AND cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
          WHERE da.user_id = ? AND cat.value = c.sales_route
            AND da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int
        )`, [vendor])
        .select(
          trx.raw('COUNT(*)::int AS cartera_hoy'),
          trx.raw(`COUNT(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM commercial.orders o WHERE o.customer_id = c.id
              AND o.created_at AT TIME ZONE 'America/Mexico_City' >= date_trunc('day', now() AT TIME ZONE 'America/Mexico_City')
          ))::int AS con_pedido_hoy`),
        );
      return { cartera_hoy: Number(row?.cartera_hoy || 0), con_pedido_hoy: Number(row?.con_pedido_hoy || 0) };
    });
  }

  private async inactive(vendor: string, daysParam?: number) {
    const days = Math.max(1, Math.min(365, Number(daysParam) || 30));
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.customers as c')
        .leftJoin('commercial.orders as o', function (this: any) {
          this.on('o.customer_id', '=', 'c.id').andOnIn('o.status', ['confirmed', 'fulfilled']);
        })
        .whereNull('c.deleted_at')
        .andWhereRaw(this.carteraSql('c'), [vendor])
        .groupBy('c.id', 'c.code', 'c.name')
        .havingRaw(`MAX(o.created_at) IS NULL OR MAX(o.created_at) < NOW() - INTERVAL '${days} days'`)
        .orderByRaw('MAX(o.created_at) ASC NULLS FIRST')
        .limit(50)
        .select('c.code', 'c.name', trx.raw('MAX(o.created_at) AS last_order'));
      return { days, customers: rows.map((r: any) => ({ code: r.code, name: r.name, last_order: r.last_order })) };
    });
  }

  private async productStock(query: string, warehouseCode?: string | null) {
    const q = query.trim();
    if (q.length < 2) return { error: 'Escribí al menos 2 caracteres.' };
    const tenantId = this.ctx.requireTenantId();
    const like = `%${q}%`;
    const wh = warehouseCode || 'MD-10';
    return this.tk.run(async (trx) => {
      const prods = await trx('catalog.products')
        .where('tenant_id', tenantId).whereNull('deleted_at')
        .andWhere((w: any) => w.whereRaw('nombre ILIKE ?', [like]).orWhereRaw('sku ILIKE ?', [like]))
        .limit(8).select('id', 'sku', 'nombre');
      if (!prods.length) return { message: `No encontré "${q}" en el catálogo.` };
      const ids = prods.map((p: any) => p.id);
      const stock = await trx('commercial.stock as s')
        .join('commercial.warehouses as w', function (this: any) { this.on('w.id', '=', 's.warehouse_id').andOn('w.tenant_id', '=', 's.tenant_id'); })
        .whereIn('s.product_id', ids).andWhere('w.code', wh)
        .groupBy('s.product_id')
        .select('s.product_id', trx.raw('COALESCE(SUM(s.quantity - s.reserved_quantity),0)::numeric AS available'));
      const m = new Map(stock.map((a: any) => [a.product_id, Number(a.available)]));
      return prods.map((p: any) => ({ sku: p.sku, product: p.nombre, available: m.get(p.id) || 0, warehouse: wh }));
    });
  }
}
