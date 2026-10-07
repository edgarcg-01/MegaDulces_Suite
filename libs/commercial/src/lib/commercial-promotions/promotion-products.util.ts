/**
 * Extrae qué productos alcanza cada promoción a partir de su `rules` (la forma
 * depende del `promotion_type`). Es el conocimiento canónico "promo → productos"
 * y vive en el módulo de promociones (su dueño). Lo consume el motor de empuje
 * (Thot) para que una promo activa también pese como señal de sugerencia —
 * cohesión empuje↔promos (CV.5). NO toca la aplicación del descuento (eso sigue
 * en orders.recalcOrderTotals); acá solo se LEE a qué productos apunta.
 *
 * `percent_off_basket` no apunta a un producto (es nivel canasta) → se omite.
 */
export interface PromoProductRef {
  product_id: string;
  code: string;
  name: string;
  promotion_type: string;
  priority: number;
}

interface PromoRow {
  code: string;
  name: string;
  promotion_type: string;
  rules: unknown;
  priority?: number | null;
}

function parseRules(rules: unknown): Record<string, any> {
  if (rules && typeof rules === 'object') return rules as Record<string, any>;
  if (typeof rules === 'string') {
    try {
      return JSON.parse(rules);
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Mapa product_id → promo que lo alcanza. Si un producto cae en varias promos,
 * conserva la de mayor prioridad (menor `priority` = más fuerte, igual que el
 * orden de aplicación en orders).
 */
export function extractPromoProducts(promos: PromoRow[]): Map<string, PromoProductRef> {
  const out = new Map<string, PromoProductRef>();
  for (const p of promos) {
    const rules = parseRules(p.rules);
    const ids: string[] = [];
    switch (p.promotion_type) {
      case 'percent_off_product':
      case 'nxm':
      case 'volume_discount':
        if (typeof rules.product_id === 'string') ids.push(rules.product_id);
        break;
      case 'cross_sell_discount':
        if (typeof rules.target_product_id === 'string') ids.push(rules.target_product_id);
        break;
      case 'bundle_fixed_price':
        if (Array.isArray(rules.items)) {
          for (const it of rules.items) {
            if (it && typeof it.product_id === 'string') ids.push(it.product_id);
          }
        }
        break;
      // percent_off_basket: nivel canasta, sin producto específico → omitido.
      default:
        break;
    }
    const priority = p.priority == null ? 100 : Number(p.priority);
    for (const id of ids) {
      const prev = out.get(id);
      if (!prev || priority < prev.priority) {
        out.set(id, {
          product_id: id,
          code: p.code,
          name: p.name,
          promotion_type: p.promotion_type,
          priority,
        });
      }
    }
  }
  return out;
}
