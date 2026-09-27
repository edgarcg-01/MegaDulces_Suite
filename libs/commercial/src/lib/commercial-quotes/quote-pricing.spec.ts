import { describe, it, expect } from 'vitest';
import { PricedLine } from './quote-pricing.service';

describe('QuotePricing — Descuentos por Volumen y Peldaño Caja (CJA)', () => {
  it('identifica y expone el volumen tier cuando existe precio de mayoreo por escala', () => {
    const mockPricedLine: PricedLine = {
      sku: '70068',
      name: 'PAL JUMBO CEREZA',
      rung: 'box',
      unit_label: 'CJA',
      factor: 15,
      quantity: 1,
      unit_price: 805.44,
      line_total: 805.44,
      unit_price_minor: 53.7,
      price_source: 'price_list',
      volume_tier: {
        min_qty: 3,
        price: 795.14,
      },
      applied: [
        {
          step: 'lista',
          source: 'v_label_prices.box_price',
          detail: 'Precio de lista para caja (CJA)',
          before: 805.44,
          after: 805.44,
        },
      ],
      not_applied: [
        {
          mechanism: 'volumen',
          reason: 'Precio por volumen de $795.14 disponible a partir de 3 CJA.',
        },
      ],
      warnings: [],
      free_goods: null,
      unpriced_reason: null,
      availability: 'available',
    };

    expect(mockPricedLine.volume_tier).toBeDefined();
    expect(mockPricedLine.volume_tier?.min_qty).toBe(3);
    expect(mockPricedLine.volume_tier?.price).toBe(795.14);
    expect(mockPricedLine.unit_price).toBe(805.44);
    expect(mockPricedLine.price_source).toBe('price_list');
    expect(mockPricedLine.not_applied[0].reason).toContain('a partir de 3 CJA');
  });

  it('aplica el precio de mayoreo cuando la cantidad alcanza o supera el umbral', () => {
    const mockPricedLineApplied: PricedLine = {
      sku: '70068',
      name: 'PAL JUMBO CEREZA',
      rung: 'box',
      unit_label: 'CJA',
      factor: 15,
      quantity: 3,
      unit_price: 795.14,
      line_total: 2385.42,
      unit_price_minor: 53.01,
      price_source: 'volume_qty',
      volume_tier: {
        min_qty: 3,
        price: 795.14,
      },
      applied: [
        {
          step: 'volumen',
          source: 'kdpv_prod_util (via v_label_prices.wholesale_*)',
          detail: 'Precio por volumen desde 3 CJA',
          before: 805.44,
          after: 795.14,
        },
      ],
      not_applied: [],
      warnings: [],
      free_goods: null,
      unpriced_reason: null,
      availability: 'available',
    };

    expect(mockPricedLineApplied.unit_price).toBe(795.14);
    expect(mockPricedLineApplied.price_source).toBe('volume_qty');
    expect(mockPricedLineApplied.applied.some((a) => a.step === 'volumen')).toBe(true);
    expect(mockPricedLineApplied.line_total).toBe(2385.42);
  });
});
