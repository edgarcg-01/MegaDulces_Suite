import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ThotSuggestion {
  product_id: string;
  product_name: string;
  price: number;
  tax_rate: number;
  min_qty: number;
  rotation_tier: string | null;
  margin_pct: number | null;
  aff_lift: number;
  zona_index: number;
  present: boolean; // el PdV ya exhibe este producto (capturas de Trade)
  pdv_marks: number; // veces marcado en las capturas de ese PdV
  score: number;
  reason: 'estrategia' | 'whitespace' | 'affinity' | 'recompra' | 'zona' | 'rotacion' | 'margen' | 'demanda';
  reason_label: string;
}

/**
 * Thot (ADR-018) — recomendación producto-first sobre el catálogo REAL del cliente.
 * El motor decide (determinista, explicable); el agente solo comunica. Score:
 *
 *   demanda = peso_rotación · margen_real        (qué se vende × qué deja)
 *   score   = demanda · (1 + 2·afinidad + 0.5·zona)
 *
 * - afinidad (cart-aware): max lift de `intelligence.product_affinity` vs lo que
 *   ya está en el carrito → driver de "completá la canasta".
 * - zona: `intelligence.zone_demand` de la zona del cliente (opcional; best-effort
 *   hasta resolver el mapeo cliente→zona).
 * - presencia (capturas de Trade vía `intelligence.pdv_presence`): qué exhibe ese PdV.
 *     · whitespace = zona compra el producto y el PdV NO lo exhibe → oportunidad (pesa más).
 *     · recompra   = el PdV ya lo exhibe → reabasto de baja fricción.
 * Cada sugerencia expone su razón dominante. No incluye lo que ya está en el carrito.
 */
@Injectable()
export class ThotService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  async suggest(
    customerId: string,
    opts: { cartProductIds?: string[]; zona?: string | null; limit?: number } = {},
  ): Promise<ThotSuggestion[]> {
    if (!UUID.test(customerId)) throw new BadRequestException('customer_id inválido');
    const cart = (opts.cartProductIds || []).filter((id) => UUID.test(id));
    const cartLiteral = `{${cart.join(',')}}`; // array literal: knex no expande un string
    const zona = opts.zona || null;
    const limit = Math.min(Math.max(Number(opts.limit) || 12, 1), 50);

    return this.tk.run(async (trx) => {
      const customer = await trx('commercial.customers')
        .where({ id: customerId })
        .whereNull('deleted_at')
        .first('default_price_list_id');
      if (!customer) throw new NotFoundException(`Customer ${customerId} no encontrado`);

      let priceListId = customer.default_price_list_id as string | null;
      if (!priceListId) {
        const def = await trx('commercial.price_lists')
          .where({ is_default: true, active: true })
          .whereNull('deleted_at')
          .first('id');
        priceListId = def?.id || null;
      }
      if (!priceListId) return [];

      const res = await trx.raw(
        `
        WITH cart_aff AS (
          SELECT product_b, MAX(lift) AS aff_lift
          FROM intelligence.product_affinity
          WHERE tenant_id = public.current_tenant_id() AND product_a = ANY(?::uuid[])
          GROUP BY product_b
        ),
        dir AS (  -- empuje dirigido del negocio (T.2): qué quiere empujar Mega Dulces
          SELECT pr.id AS product_id, MAX(d.boost) AS strat_boost,
                 (array_agg(d.reason ORDER BY d.boost DESC))[1] AS strat_reason
          FROM intelligence.push_directives d
          JOIN catalog.products pr
            ON (d.target_kind = 'product'  AND d.target_id = pr.id)
            OR (d.target_kind = 'brand'    AND d.target_id = pr.brand_id)
            OR (d.target_kind = 'category' AND d.target_id = pr.category_id)
          WHERE d.tenant_id = public.current_tenant_id()
            AND d.active = true AND d.deleted_at IS NULL
            AND (d.valid_from IS NULL OR d.valid_from <= CURRENT_DATE)
            AND (d.valid_to   IS NULL OR d.valid_to   >= CURRENT_DATE)
          GROUP BY pr.id
        ),
        cand AS (
          SELECT p.id AS product_id, p.nombre AS product_name,
                 pp.price, COALESCE(pp.tax_rate, 0) AS tax_rate, COALESCE(pp.min_qty, 1) AS min_qty,
                 p.rotation_tier, p.sales_units_30d,
                 CASE WHEN p.cost_with_tax > 0 AND pp.price > 0
                      THEN (pp.price - p.cost_with_tax / (1 + COALESCE(pp.tax_rate, 0))) / pp.price
                      ELSE NULL END AS margin_net,
                 COALESCE(ca.aff_lift, 0) AS aff_lift,
                 COALESCE(zd.demand_index, 0) AS zona_index,
                 COALESCE(dr.strat_boost, 0) AS strat_boost,
                 dr.strat_reason,
                 COALESCE(pv.marks, 0) AS pdv_marks,
                 (pv.product_id IS NOT NULL) AS present,
                 CASE WHEN pv.product_id IS NOT NULL AND pv.last_seen IS NOT NULL
                      THEN GREATEST(0, 1 - EXTRACT(EPOCH FROM (NOW() - pv.last_seen)) / (180 * 86400.0))
                      ELSE (pv.product_id IS NOT NULL)::int END AS present_recency,
                 (CASE p.rotation_tier WHEN 'alta' THEN 1 WHEN 'media' THEN 0.6 WHEN 'baja' THEN 0.2 ELSE 0.1 END) AS rot_w
          FROM catalog.products p
          JOIN commercial.product_prices pp
            ON pp.product_id = p.id AND pp.tenant_id = p.tenant_id
           AND pp.price_list_id = ? AND pp.deleted_at IS NULL AND pp.price > 0
          LEFT JOIN catalog.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
          LEFT JOIN cart_aff ca ON ca.product_b = p.id
          LEFT JOIN intelligence.zone_demand zd
            ON zd.product_id = p.id AND zd.tenant_id = p.tenant_id AND zd.zona = ?
          LEFT JOIN intelligence.pdv_presence pv
            ON pv.product_id = p.id AND pv.tenant_id = p.tenant_id AND pv.customer_id = ?
          LEFT JOIN dir dr ON dr.product_id = p.id
          WHERE p.tenant_id = public.current_tenant_id() AND p.deleted_at IS NULL
            AND (b.is_commercial = true OR b.is_commercial IS NULL)
            AND NOT (p.id = ANY(?::uuid[]))
            AND p.nombre NOT ILIKE '%GRATIS%'
        )
        SELECT *,
               -- demanda (qué se vende × deja) amplificada por afinidad/zona,
               -- + piso aditivo por empuje dirigido: una directriz manual ES
               -- intención del negocio → garantiza visibilidad (escala con boost).
               -- + whitespace: zona compra el producto y el PdV NO lo exhibe (capturas) → pesa más.
               -- + recompra: el PdV ya lo exhibe → empujón suave de reabasto (decae con recencia).
               -- El guardrail de "no junk/agotado" lo dan los filtros (priced/commercial/GRATIS).
               (rot_w * GREATEST(COALESCE(margin_net, 0), 0))
                 * (1 + 2.0 * LEAST(aff_lift / 15.0, 1) + 0.5 * zona_index)
               + 0.45 * strat_boost
               + 0.6 * (zona_index * (CASE WHEN present THEN 0 ELSE 1 END))
               + 0.25 * present_recency AS score
        FROM cand
        ORDER BY score DESC NULLS LAST
        LIMIT ?
        `,
        [cartLiteral, priceListId, zona, customerId, cartLiteral, limit],
      );

      const hasCart = cart.length > 0;
      // Anti-leak: el cliente (Portal) no ve margen. El motor igual lo usa para
      // rankear; solo se oculta el % en la respuesta.
      const stripMargin = this.ctx.get()?.roleName === 'customer_b2b';
      return res.rows
        .filter((r: any) => Number(r.score) > 0)
        .map((r: any): ThotSuggestion => {
          const aff = Math.min((Number(r.aff_lift) || 0) / 15, 1);
          const zonaIdx = Number(r.zona_index) || 0;
          const margin = r.margin_net == null ? null : Number(r.margin_net);
          const present = r.present === true || r.present === 't';
          const pdvMarks = Number(r.pdv_marks) || 0;
          let reason: ThotSuggestion['reason'] = 'demanda';
          let label = 'Recomendado';
          if (Number(r.strat_boost) > 0 && r.strat_reason) { reason = 'estrategia'; label = r.strat_reason; }
          else if (!present && zonaIdx >= 0.5) { reason = 'whitespace'; label = 'Falta en tu tienda'; }
          else if (hasCart && aff >= 0.3) { reason = 'affinity'; label = 'Va con lo que llevas'; }
          else if (present && pdvMarks > 0) { reason = 'recompra'; label = 'Ya lo manejas'; }
          else if (zonaIdx >= 0.5) { reason = 'zona'; label = 'Se vende en tu zona'; }
          else if (r.rotation_tier === 'alta') { reason = 'rotacion'; label = 'Alta rotación'; }
          else if (!stripMargin && margin != null && margin >= 0.25) { reason = 'margen'; label = 'Buen margen'; }
          return {
            product_id: r.product_id,
            product_name: r.product_name,
            price: Number(r.price),
            tax_rate: Number(r.tax_rate),
            min_qty: Number(r.min_qty),
            rotation_tier: r.rotation_tier ?? null,
            margin_pct: stripMargin || margin == null ? null : Math.round(margin * 100),
            aff_lift: Math.round(Number(r.aff_lift) * 10) / 10,
            zona_index: Math.round(zonaIdx * 100) / 100,
            present,
            pdv_marks: pdvMarks,
            score: Math.round(Number(r.score) * 1000) / 1000,
            reason,
            reason_label: label,
          };
        });
    });
  }
}
