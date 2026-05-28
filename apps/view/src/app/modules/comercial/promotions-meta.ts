import { PromotionType } from './comercial.service';

/**
 * Metadata visual + comportamiento por tipo de promoción. Centralizado acá
 * para que el list (badge), el type-selector (grid de cards) y el preview
 * (resumen humano de qué hace la promo) lean del MISMO source.
 *
 * Si agregás un tipo nuevo, vas a:
 *   1. Backend: agregar al enum + CHECK + validateRulesForType
 *   2. Acá: agregar entry a PROMOTION_META
 *   3. UI: agregar el form específico en el componente
 */
export interface PromotionMeta {
  type: PromotionType;
  label: string;
  shortLabel: string; // para badge en lista
  icon: string; // pi pi-...
  color: string; // CSS color para badge
  description: string;
  example: string;
}

export const PROMOTION_META: Record<PromotionType, PromotionMeta> = {
  percent_off_product: {
    type: 'percent_off_product',
    label: 'Descuento % en producto',
    shortLabel: '% off producto',
    icon: 'pi pi-percentage',
    color: '#3b82f6',
    description: 'Aplica un porcentaje de descuento sobre un producto específico.',
    example: '-15% en Trufas Surtidas 12pz',
  },
  percent_off_basket: {
    type: 'percent_off_basket',
    label: 'Descuento % en pedido total',
    shortLabel: '% off pedido',
    icon: 'pi pi-shopping-bag',
    color: '#8b5cf6',
    description: 'Aplica un descuento al total del pedido. Opcional: mínimo de compra.',
    example: '-10% en pedidos > $5,000',
  },
  nxm: {
    type: 'nxm',
    label: 'NxM (2x1, 3x2, etc.)',
    shortLabel: 'NxM',
    icon: 'pi pi-clone',
    color: '#16a34a',
    description: 'Compra N unidades del producto, paga sólo M.',
    example: '2x1, 3x2 en Pulparindo',
  },
  volume_discount: {
    type: 'volume_discount',
    label: 'Descuento por volumen',
    shortLabel: 'Volumen',
    icon: 'pi pi-chart-bar',
    color: '#f59e0b',
    description: 'Tiers por cantidad: a más unidades, mayor descuento.',
    example: '10+ unidades: -5%, 30+: -12%',
  },
  bundle_fixed_price: {
    type: 'bundle_fixed_price',
    label: 'Pack a precio fijo',
    shortLabel: 'Pack',
    icon: 'pi pi-box',
    color: '#ec4899',
    description: 'Combo de varios productos a un precio total fijo.',
    example: 'Pack dulcería básica $499',
  },
  cross_sell_discount: {
    type: 'cross_sell_discount',
    label: 'Compra cruzada',
    shortLabel: 'Cross-sell',
    icon: 'pi pi-arrow-right-arrow-left',
    color: '#06b6d4',
    description: 'Si compra el producto A, descuento en el producto B.',
    example: 'Trufas + Chocolates → -20% en Chocolates',
  },
};

export const PROMOTION_META_LIST: PromotionMeta[] = Object.values(PROMOTION_META);

/**
 * Resume en lenguaje natural qué hace una promo, leyendo sus rules.
 * Usado en la tabla y tooltips.
 */
export function summarizePromotion(
  type: PromotionType,
  rules: any,
  productName: (id: string) => string,
): string {
  if (!rules) return PROMOTION_META[type]?.label || type;
  switch (type) {
    case 'percent_off_product':
      return `-${rules.percent}% en ${productName(rules.product_id)}`;
    case 'percent_off_basket':
      return `-${rules.percent}% al total del pedido`;
    case 'nxm':
      return `${rules.n_buy}x${rules.m_pay} en ${productName(rules.product_id)}`;
    case 'volume_discount': {
      const tiers = (rules.tiers || []) as Array<{ min_qty: number; percent: number }>;
      const last = tiers[tiers.length - 1];
      return tiers.length > 0
        ? `Volumen en ${productName(rules.product_id)} (hasta -${last.percent}%)`
        : `Volumen en ${productName(rules.product_id)}`;
    }
    case 'bundle_fixed_price': {
      const items = (rules.items || []) as Array<{ product_id: string; quantity: number }>;
      return `Pack de ${items.length} productos por $${rules.price}`;
    }
    case 'cross_sell_discount':
      return `Comprá ${productName(rules.trigger_product_id)} → -${rules.percent}% en ${productName(rules.target_product_id)}`;
    default:
      return type;
  }
}
