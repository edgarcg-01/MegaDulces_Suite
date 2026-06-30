import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { ThotService } from '../thot.service';
import { ThotToolDef, ThotToolProvider, ThotScope } from './thot-tool-provider';
import { buildPortalSystemPrompt } from './thot-semantic';

/**
 * TC-P (ADR-026) — Tools del Portal B2B. TODO scoped al `customerId` del JWT
 * (impuesto server-side, jamás del LLM). Sin márgenes, sin datos de terceros, sin
 * analítica global. Disponibilidad de producto desde el almacén de surtido (PH).
 */
@Injectable()
export class PortalThotToolsService implements ThotToolProvider {
  private readonly logger = new Logger(PortalThotToolsService.name);

  constructor(
    private readonly thot: ThotService,
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  systemPrompt(scope: ThotScope, ctx: { today: string }): string {
    return buildPortalSystemPrompt({ today: ctx.today, userName: scope.userName || undefined });
  }

  definitions(_scope: ThotScope): ThotToolDef[] {
    return [
      { name: 'thot_my_recommendations', description: 'Productos que te conviene pedir (recomendación personalizada para tu negocio). Para "¿qué me conviene?", "¿qué pido?".', input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Default 12.' } } } },
      { name: 'thot_my_orders', description: 'Tus pedidos recientes (folio, estado, total, fecha).', input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Default 15.' } } } },
      { name: 'thot_my_last_order', description: 'Tu último pedido con su detalle de productos. Para "repíteme mi último pedido", "¿qué pedí la última vez?".', input_schema: { type: 'object', properties: {} } },
      { name: 'thot_my_usual_products', description: 'Los productos que más sueles comprar (tu historial). Para "lo de siempre", "mi pedido habitual".', input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Default 20.' } } } },
      { name: 'thot_catalog_search', description: 'Busca productos en el catálogo con TU precio y si hay disponibilidad. Para "¿tienen X?", "precio de X".', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Nombre o SKU del producto.' } }, required: ['query'] } },
      { name: 'thot_product_availability', description: 'Dice si un producto está disponible para surtirte ahora (desde la sucursal que te surte).', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Nombre o SKU del producto.' } }, required: ['query'] } },
      { name: 'thot_my_promotions', description: 'Promociones vigentes disponibles para ti.', input_schema: { type: 'object', properties: {} } },
    ];
  }

  async execute(name: string, input: any, scope: ThotScope): Promise<any> {
    const args = input || {};
    const customerId = scope.customerId;
    if (!customerId) return { error: 'No hay cliente en el contexto.' };
    try {
      switch (name) {
        case 'thot_my_recommendations': {
          const limit = Math.min(20, Math.max(1, Number(args.limit) || 12));
          // suggest() stripea margen para customer_b2b por rol; acá igual no lo exponemos.
          const rows = await this.thot.suggest(customerId, { limit });
          return rows.map((r) => ({ product: r.product_name, price: r.price, min_qty: r.min_qty, reason: r.reason_label }));
        }
        case 'thot_my_orders':
          return await this.myOrders(customerId, args.limit);
        case 'thot_my_last_order':
          return await this.myLastOrder(customerId);
        case 'thot_my_usual_products':
          return await this.myUsualProducts(customerId, args.limit);
        case 'thot_catalog_search':
          return await this.catalogSearch(customerId, String(args.query || ''), scope.warehouseCode);
        case 'thot_product_availability':
          return await this.availability(String(args.query || ''), scope.warehouseCode);
        case 'thot_my_promotions':
          return await this.promotions();
        default:
          return { error: `Tool no disponible en el portal: ${name}` };
      }
    } catch (e: any) {
      this.logger.warn(`Portal tool ${name} falló: ${e?.message || e}`);
      return { error: `No pude consultar eso ahora (${name}).` };
    }
  }

  private async myOrders(customerId: string, limitParam?: number) {
    const limit = Math.min(50, Math.max(1, Number(limitParam) || 15));
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.orders')
        .where({ customer_id: customerId })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .limit(limit)
        .select('code', 'status', 'total', 'created_at');
      return rows.map((r: any) => ({ folio: r.code, status: r.status, total: Number(r.total), date: r.created_at }));
    });
  }

  private async myLastOrder(customerId: string) {
    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders')
        .where({ customer_id: customerId })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first('id', 'code', 'status', 'total', 'created_at');
      if (!order) return { message: 'Aún no tienes pedidos.' };
      const lines = await trx('commercial.order_lines as ol')
        .join('catalog.products as p', 'p.id', 'ol.product_id')
        .where('ol.order_id', order.id)
        .select('p.nombre as product', 'ol.quantity', 'ol.unit_price', 'ol.line_total');
      return {
        folio: order.code, status: order.status, total: Number(order.total), date: order.created_at,
        items: lines.map((l: any) => ({ product: l.product, quantity: Number(l.quantity), unit_price: Number(l.unit_price), line_total: Number(l.line_total) })),
      };
    });
  }

  private async myUsualProducts(customerId: string, limitParam?: number) {
    const limit = Math.min(50, Math.max(1, Number(limitParam) || 20));
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .join('catalog.products as p', 'p.id', 'ol.product_id')
        .where('o.customer_id', customerId)
        .whereIn('o.status', ['confirmed', 'fulfilled'])
        .groupBy('p.sku', 'p.nombre')
        .orderByRaw('SUM(ol.quantity) DESC')
        .limit(limit)
        .select('p.sku', 'p.nombre as product',
          trx.raw('SUM(ol.quantity)::numeric AS units'),
          trx.raw('COUNT(DISTINCT o.id)::int AS times'),
          trx.raw('MAX(o.created_at) AS last_purchase'));
      return rows.map((r: any) => ({ sku: r.sku, product: r.product, units: Number(r.units), times: Number(r.times), last_purchase: r.last_purchase }));
    });
  }

  /** Lista de precios del cliente (su default, o la default del tenant). */
  private async priceListId(trx: any, customerId: string): Promise<string | null> {
    const c = await trx('commercial.customers').where({ id: customerId }).first('default_price_list_id');
    if (c?.default_price_list_id) return c.default_price_list_id;
    const def = await trx('commercial.price_lists').where({ is_default: true, active: true }).whereNull('deleted_at').first('id');
    return def?.id || null;
  }

  private async catalogSearch(customerId: string, query: string, warehouseCode?: string | null) {
    const q = query.trim();
    if (q.length < 2) return { error: 'Escribí al menos 2 caracteres.' };
    const tenantId = this.ctx.requireTenantId();
    const like = `%${q}%`;
    const wh = warehouseCode || 'MD-10';
    return this.tk.run(async (trx) => {
      const plId = await this.priceListId(trx, customerId);
      const rows = await trx('catalog.products as p')
        .leftJoin('commercial.product_prices as pp', function (this: any) {
          this.on('pp.product_id', '=', 'p.id').andOn('pp.price_list_id', '=', trx.raw('?', [plId])).andOnNull('pp.deleted_at');
        })
        .where('p.tenant_id', tenantId)
        .whereNull('p.deleted_at')
        .andWhere((w: any) => w.whereRaw('p.nombre ILIKE ?', [like]).orWhereRaw('p.sku ILIKE ?', [like]))
        .limit(12)
        .select('p.id', 'p.sku', 'p.nombre as product', 'pp.price', 'pp.min_qty');
      // disponibilidad en PH por cada producto
      const ids = rows.map((r: any) => r.id);
      const avail = ids.length ? await trx('commercial.stock as s')
        .join('commercial.warehouses as w', function (this: any) { this.on('w.id', '=', 's.warehouse_id').andOn('w.tenant_id', '=', 's.tenant_id'); })
        .whereIn('s.product_id', ids).andWhere('w.code', wh)
        .groupBy('s.product_id')
        .select('s.product_id', trx.raw('COALESCE(SUM(s.quantity - s.reserved_quantity),0)::numeric AS available')) : [];
      const availMap = new Map(avail.map((a: any) => [a.product_id, Number(a.available)]));
      return rows.map((r: any) => ({
        sku: r.sku, product: r.product,
        price: r.price != null ? Number(r.price) : null,
        min_qty: r.min_qty != null ? Number(r.min_qty) : 1,
        available: (availMap.get(r.id) || 0) > 0,
      }));
    });
  }

  private async availability(query: string, warehouseCode?: string | null) {
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
      const avail = await trx('commercial.stock as s')
        .join('commercial.warehouses as w', function (this: any) { this.on('w.id', '=', 's.warehouse_id').andOn('w.tenant_id', '=', 's.tenant_id'); })
        .whereIn('s.product_id', ids).andWhere('w.code', wh)
        .groupBy('s.product_id')
        .select('s.product_id', trx.raw('COALESCE(SUM(s.quantity - s.reserved_quantity),0)::numeric AS available'));
      const m = new Map(avail.map((a: any) => [a.product_id, Number(a.available)]));
      return prods.map((p: any) => ({ sku: p.sku, product: p.nombre, available: (m.get(p.id) || 0) > 0 }));
    });
  }

  private async promotions() {
    const now = new Date();
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.promotions')
        .where({ active: true })
        .whereNull('deleted_at')
        .andWhere((qb: any) => qb.whereNull('starts_at').orWhere('starts_at', '<=', now))
        .andWhere((qb: any) => qb.whereNull('ends_at').orWhere('ends_at', '>', now))
        .limit(50)
        .select('code', 'name', 'promotion_type', 'starts_at', 'ends_at');
      return rows.map((r: any) => ({ name: r.name, type: r.promotion_type, until: r.ends_at }));
    });
  }
}
