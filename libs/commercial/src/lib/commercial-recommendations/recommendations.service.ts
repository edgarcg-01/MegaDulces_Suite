import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import {
  RecommendationItem,
  RecommendationCategory,
  RECOMMENDATION_LIMITS,
  RecommendedBasket,
} from './recommendations.types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canasta estratégica por customer.
 *
 * Cómputo heurístico (sin ML por ahora):
 *
 *   1. base — top N productos que el customer COMPRA últimos 90 días (units_sold desc).
 *   2. focus — top N productos del tenant últimos 30 días que este customer NO ha comprado nunca.
 *   3. exploration — productos de las brands que el customer ya compra, pero del SKU que no probó.
 *   4. innovation — productos creados en los últimos 30 días.
 *
 * Limitaciones conocidas:
 *   - "innovation" usa products.created_at — refleja cuándo se cargó al catálogo, no
 *     necesariamente cuándo se lanzó al mercado.
 *   - "score" es simple normalización por categoría (no comparable cross-cat sin contexto).
 *   - Sin colaboración (no aprendemos de customers similares). Eso vendría con ML.
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Computa la canasta para el customer y la guarda (UPSERT).
   * Retorna el set completo.
   */
  async computeForCustomer(customerId: string): Promise<RecommendedBasket> {
    if (!UUID_REGEX.test(customerId))
      throw new BadRequestException('customer_id inválido');

    return this.tk.run(async (trx) => {
      // Validar que existe
      const customer = await trx('commercial.customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first();
      if (!customer) throw new NotFoundException(`Customer ${customerId} no existe`);

      // Resolver lista de precio para anotar sample_price en cada item
      const priceListId =
        customer.default_price_list_id ||
        (
          await trx('commercial.price_lists')
            .where({ is_default: true, active: true })
            .whereNull('deleted_at')
            .first()
        )?.id;

      const priceMap = new Map<string, number>(); // product_id → price
      if (priceListId) {
        const prices = await trx('commercial.product_prices')
          .where({ price_list_id: priceListId })
          .whereNull('deleted_at')
          .select('product_id', 'price');
        prices.forEach((p) => priceMap.set(p.product_id, Number(p.price)));
      }

      // Brand info (product_id → brand_name)
      const productMeta = await trx('public.products as p')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .select('p.id', 'p.nombre as product_name', 'b.nombre as brand_name', 'p.created_at');
      const productMetaMap = new Map<string, any>();
      productMeta.forEach((p) => productMetaMap.set(p.id, p));

      // ─── 1. BASE: top productos del customer últimos 90 días ───
      const baseRows = await trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .where('o.customer_id', customerId)
        .whereIn('o.status', ['confirmed', 'fulfilled'])
        .whereNull('o.deleted_at')
        .whereRaw(`o.created_at >= NOW() - INTERVAL '${RECOMMENDATION_LIMITS.CUSTOMER_HISTORY_DAYS} days'`)
        .groupBy('ol.product_id')
        .select(
          'ol.product_id',
          trx.raw('COALESCE(SUM(ol.quantity), 0)::numeric as units'),
          trx.raw('COUNT(DISTINCT o.id)::int as order_count'),
        )
        .orderByRaw('SUM(ol.quantity) DESC')
        .limit(RECOMMENDATION_LIMITS.BASE);

      const customerProductIds = new Set(baseRows.map((r) => r.product_id));
      const customerBrandIds = new Set<string>();

      const items: RecommendationItem[] = [];
      const maxBaseUnits = baseRows.length > 0 ? Math.max(...baseRows.map((r) => Number(r.units))) : 1;

      for (const r of baseRows) {
        const meta = productMetaMap.get(r.product_id);
        if (!meta) continue;
        // Capturar brand_id (no nombre) para exploration — necesitamos el id real.
        const brandRow = await trx('public.products').where({ id: r.product_id }).select('brand_id').first();
        if (brandRow?.brand_id) customerBrandIds.add(brandRow.brand_id);
        items.push({
          product_id: r.product_id,
          product_name: meta.product_name,
          brand_name: meta.brand_name,
          category: 'base',
          score: +(Number(r.units) / (maxBaseUnits || 1)).toFixed(3),
          reason: `Compraste ${Number(r.units).toFixed(0)} unidades en ${r.order_count} pedido(s) recientes`,
          sample_price: priceMap.get(r.product_id) || 0,
          units_in_last_period: Number(r.units),
        });
      }

      // ─── 2. FOCUS: top productos del TENANT que el customer NO compra ───
      const focusRows = await trx('commercial.order_lines as ol')
        .join('commercial.orders as o', 'o.id', 'ol.order_id')
        .whereIn('o.status', ['confirmed', 'fulfilled'])
        .whereNull('o.deleted_at')
        .whereRaw(`o.created_at >= NOW() - INTERVAL '${RECOMMENDATION_LIMITS.TENANT_TOP_DAYS} days'`)
        .modify((qb) => {
          if (customerProductIds.size > 0) {
            qb.whereNotIn('ol.product_id', [...customerProductIds]);
          }
        })
        .groupBy('ol.product_id')
        .select(
          'ol.product_id',
          trx.raw('COALESCE(SUM(ol.quantity), 0)::numeric as units'),
          trx.raw('COUNT(DISTINCT o.customer_id)::int as buyers'),
        )
        .orderByRaw('SUM(ol.quantity) DESC')
        .limit(RECOMMENDATION_LIMITS.FOCUS);

      const maxFocusUnits = focusRows.length > 0 ? Math.max(...focusRows.map((r) => Number(r.units))) : 1;
      for (const r of focusRows) {
        const meta = productMetaMap.get(r.product_id);
        if (!meta) continue;
        items.push({
          product_id: r.product_id,
          product_name: meta.product_name,
          brand_name: meta.brand_name,
          category: 'focus',
          score: +(Number(r.units) / (maxFocusUnits || 1)).toFixed(3),
          reason: `${r.buyers} cliente(s) lo compraron este mes — no está en tu historial`,
          sample_price: priceMap.get(r.product_id) || 0,
          units_in_last_period: Number(r.units),
        });
      }

      // ─── 3. EXPLORATION: otros productos de SUS brands ───
      const explorationIds = new Set([
        ...customerProductIds,
        ...items.filter((i) => i.category === 'focus').map((i) => i.product_id),
      ]);
      if (customerBrandIds.size > 0) {
        const explorationRows = await trx('public.products')
          .whereIn('brand_id', [...customerBrandIds])
          .where('activo', true)
          .whereNull('deleted_at')
          .whereNotIn('id', [...explorationIds])
          .orderBy('puntuacion', 'desc')
          .limit(RECOMMENDATION_LIMITS.EXPLORATION);

        for (const p of explorationRows) {
          const meta = productMetaMap.get(p.id);
          items.push({
            product_id: p.id,
            product_name: p.nombre,
            brand_name: meta?.brand_name,
            category: 'exploration',
            score: 0.5, // sin métrica fuerte; placeholder
            reason: `Marca ${meta?.brand_name || ''} que ya compras — este SKU no lo probaste`,
            sample_price: priceMap.get(p.id) || 0,
          });
        }
      }

      // ─── 4. INNOVATION: productos nuevos del catálogo ───
      const innovationRows = await trx('public.products')
        .where('activo', true)
        .whereNull('deleted_at')
        .whereRaw(`created_at >= NOW() - INTERVAL '${RECOMMENDATION_LIMITS.INNOVATION_DAYS} days'`)
        .whereNotIn(
          'id',
          items.length > 0 ? items.map((i) => i.product_id) : ['00000000-0000-0000-0000-000000000000'],
        )
        .orderBy('created_at', 'desc')
        .limit(RECOMMENDATION_LIMITS.INNOVATION);

      for (const p of innovationRows) {
        const meta = productMetaMap.get(p.id);
        const daysOld = Math.floor((Date.now() - new Date(p.created_at).getTime()) / 86400000);
        items.push({
          product_id: p.id,
          product_name: p.nombre,
          brand_name: meta?.brand_name,
          category: 'innovation',
          score: 0.4,
          reason: `Producto nuevo (agregado hace ${daysOld} día${daysOld === 1 ? '' : 's'})`,
          sample_price: priceMap.get(p.id) || 0,
        });
      }

      // ─── Persist + return ───
      const categoryCounts: Record<RecommendationCategory, number> = {
        base: items.filter((i) => i.category === 'base').length,
        focus: items.filter((i) => i.category === 'focus').length,
        exploration: items.filter((i) => i.category === 'exploration').length,
        innovation: items.filter((i) => i.category === 'innovation').length,
      };

      await trx('commercial.recommended_baskets')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          customer_id: customerId,
          items: JSON.stringify(items),
          category_counts: JSON.stringify(categoryCounts),
          total_recommendations: items.length,
          computed_at: trx.fn.now(),
        })
        .onConflict(['tenant_id', 'customer_id'])
        .merge(['items', 'category_counts', 'total_recommendations', 'computed_at', 'updated_at']);

      return {
        customer_id: customerId,
        computed_at: new Date().toISOString(),
        total_recommendations: items.length,
        category_counts: categoryCounts,
        items,
      };
    });
  }

  /**
   * Lee la canasta guardada del customer. Si no existe o está stale (>24h),
   * recomputa on-demand y devuelve el set fresco.
   */
  async getForCustomer(customerId: string): Promise<RecommendedBasket> {
    if (!UUID_REGEX.test(customerId))
      throw new BadRequestException('customer_id inválido');

    return this.tk.run(async (trx) => {
      const row = await trx('commercial.recommended_baskets')
        .where({ customer_id: customerId })
        .first();

      const isStale =
        !row ||
        (Date.now() - new Date(row.computed_at).getTime()) > 24 * 60 * 60 * 1000;

      if (isStale) {
        // Sale del tk.run() y vuelve a entrar — ineficiente pero correcto.
        return this.computeForCustomer(customerId);
      }

      return {
        customer_id: row.customer_id,
        computed_at: row.computed_at,
        total_recommendations: row.total_recommendations,
        category_counts:
          typeof row.category_counts === 'string'
            ? JSON.parse(row.category_counts)
            : row.category_counts,
        items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
      };
    });
  }

  /**
   * Para el customer del JWT actual (Portal B2B).
   */
  async getForMyCustomer(): Promise<RecommendedBasket> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) {
      throw new BadRequestException('Usuario no identificado');
    }
    const customerId = await this.tk.run(async (trx) => {
      const r = await trx('public.users').where({ id: userId }).select('customer_id').first();
      return r?.customer_id;
    });
    if (!customerId) {
      throw new BadRequestException(
        'Usuario sin customer_id linkeado — no es customer_b2b',
      );
    }
    return this.getForCustomer(customerId);
  }
}
