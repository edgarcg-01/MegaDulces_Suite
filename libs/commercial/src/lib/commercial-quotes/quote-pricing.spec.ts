// [CG.38.1] Sin `import ... from 'vitest'`: la config usa `globals: true`. Importarlo hace que el
// archivo NO CARGUE y entonces reporta **0 tests**, no sus casos fallando.
import { LadderParaRotulo, motivoPromoSinSaldo, PricedLine, rungDeRotulo, unidadIntermedia } from './quote-pricing.service';

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

// ──────────────────────────────────────────────────────────────────────────────────────────────
// `[COT.16]` El rótulo guardado → peldaño. Los tres casos salen de PROD (2026-10-01), no de la
// imaginación: `17083` (base KG, bulto de 20), `15143` (el bulto ES la base, sin caja) y `99040`
// (base cubeta Y caja real de 14). La función es pura justamente para poder afirmarlo de verdad.
// ──────────────────────────────────────────────────────────────────────────────────────────────
describe('[COT.16] rungDeRotulo — el mismo rótulo es base en un producto y unidad mayor en otro', () => {
  const esc = (unit_base: string | null, pack: string | null, box: string | null): LadderParaRotulo => ({
    unit_base,
    rungs: {
      base: { rung: 'base', label: unit_base, price: 1, size: 1, volume: null },
      pack: { rung: 'pack', label: pack, price: pack ? 1 : null, size: pack ? 2 : null, volume: null },
      box: { rung: 'box', label: box, price: box ? 1 : null, size: box ? 20 : null, volume: null },
    },
  });

  // 17083 "ALTOS CAM CHICA 1KG": base KG, bulto de 20 kg a $1,169.91 (y Kepler facturó 223
  // renglones por BTO con factor 20.0000 — `mv_kepler_unit_ladder`).
  const granel = esc('KG', null, 'BTO');
  it('17083: BTO es la unidad MAYOR → box', () => expect(rungDeRotulo('BTO', granel)).toBe('box'));
  it('17083: su base sigue siendo base', () => expect(rungDeRotulo('KG', granel)).toBe('base'));

  // 15143: el bulto es la unidad BASE y no hay caja. Antes caía en `box` y re-tasaba contra un
  // peldaño inexistente al editar la cantidad de un renglón ya guardado.
  const baseBulto = esc('BTO', null, null);
  it('15143: BTO es la unidad BASE → base, no box', () => expect(rungDeRotulo('BTO', baseBulto)).toBe('base'));
  it('15143: "BULTO" escrito largo resuelve igual', () => expect(rungDeRotulo('BULTO', baseBulto)).toBe('base'));

  // 99040: base cubeta ($54.00) Y caja real de 14 ($756.00). Refuta "si la base es CUB no hay caja".
  const cubetaConCaja = esc('CUB', null, 'CJA');
  it('99040: CUB (su base) → base', () => expect(rungDeRotulo('CUB', cubetaConCaja)).toBe('base'));
  it('99040: CJA (su caja real) → box', () => expect(rungDeRotulo('CJA', cubetaConCaja)).toBe('box'));

  // Lo de siempre no se movió.
  const clasico = esc('PZA', 'PAQ', 'CJA');
  it('CJA sigue siendo box', () => expect(rungDeRotulo('CJA', clasico)).toBe('box'));
  it('PAQ sigue siendo pack', () => expect(rungDeRotulo('PAQ', clasico)).toBe('pack'));
  it('PZA sigue siendo base', () => expect(rungDeRotulo('PZA', clasico)).toBe('base'));
  it('un rótulo que no casa con ningún peldaño cae a base', () => expect(rungDeRotulo('SER', clasico)).toBe('base'));
  it('sin rótulo, base', () => expect(rungDeRotulo(null, clasico)).toBe('base'));

  // Prueba negativa: si la caja del sku se llama BTO, BTO tiene que ser box — o el arreglo
  // estaría resolviendo por "BTO siempre es base", que es el error espejo.
  it('prueba negativa: BTO NO es base cuando sí es la caja del producto', () => {
    expect(rungDeRotulo('BTO', esc('KG', null, 'BTO'))).toBe('box');
    expect(rungDeRotulo('BTO', esc('BTO', null, null))).toBe('base');
  });

  // Sin escalera se conserva el mapeo histórico (nunca mandó BTO a box).
  it('sin escalera, el mapeo histórico', () => {
    expect(rungDeRotulo('CJA', null)).toBe('box');
    expect(rungDeRotulo('BTO', null)).toBe('base');
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────
// `[PDV.4]` Promoción con saldo 0: el mostrador no la da SI la tienda lleva control de saldo (medido en
// U-D-10 de 14 días: 05 → 49.5 % con saldo vs 22.4 % sin él; 08 → 98.7 % vs 36.1 %).
// ──────────────────────────────────────────────────────────────────────────────────────────────
describe('[PDV.4] motivoPromoSinSaldo — saldo 0 en una tienda que lleva saldo no se aplica', () => {
  const r = (saldo_estado: string | null, tienda_lleva_saldo: boolean, mecanismo = 'descuento_cantidad') => ({ mecanismo, saldo_estado, tienda_lleva_saldo });
  it('saldo 0 en tienda con control: se declara, no se aplica', () => {
    expect(motivoPromoSinSaldo(r('sin_control', true))).toContain('saldo 0');
  });
  it('con saldo: se aplica', () => {
    expect(motivoPromoSinSaldo(r('con_saldo', true))).toBeNull();
  });
  it('tienda que no lleva la columna (el cero no dice nada): se aplica', () => {
    expect(motivoPromoSinSaldo(r('sin_control', false))).toBeNull();
  });
  it('agotada sigue como antes (se aplica con advertencia aparte)', () => {
    expect(motivoPromoSinSaldo(r('agotada', true))).toBeNull();
  });
  it('sólo descuento por cantidad: el regalo no está medido', () => {
    expect(motivoPromoSinSaldo(r('sin_control', true, 'gratis_cantidad'))).toBeNull();
  });
});

// [COT.30] La unidad intermedia que no es PAQ. Caso real (01, 2026-11-06): 70500 LA ROSA CERETZZA
// = base `500` (medio kilo) · KG de 2 a $151.42 · CJA de 20 a $1,389.05.
describe('unidadIntermedia — KG/BTO en la ranura del paquete', () => {
  const fila = (unidad: string, factor: number | null, precio: number | null, origen = 'ranura') =>
    ({ sku: '70500', unidad, factor, precio_lista: precio, mayoreo_precio: null, mayoreo_desde: null, origen });
  const vista = [fila('CJA', 20, 1389.05), fila('KG', 2, 151.42)];

  it('70500: el KG de 2 es la intermedia, por debajo de la caja', () => {
    expect(unidadIntermedia(vista, '500', { label: 'CJA', size: 20 })?.unidad).toBe('KG');
  });
  it('no es intermedia si iguala o rebasa a la mayor', () => {
    expect(unidadIntermedia([fila('BTO', 20, 900)], 'KG', { label: 'CJA', size: 20 })).toBeNull();
  });
  it('nunca la misma unidad que la mayor ni que la base', () => {
    expect(unidadIntermedia([fila('BTO', 10, 500)], 'KG', { label: 'BTO', size: 10 })).toBeNull();
    expect(unidadIntermedia([fila('KG', 2, 151.42)], 'KG', { label: 'CJA', size: 20 })).toBeNull();
  });
  it('sin precio o de la escalera derivada no cuenta (no se ofrece un botón sin precio detrás)', () => {
    expect(unidadIntermedia([fila('KG', 2, null)], '500', { label: 'CJA', size: 20 })).toBeNull();
    expect(unidadIntermedia([fila('KG', 2, 151.42, 'escalera')], '500', { label: 'CJA', size: 20 })).toBeNull();
  });
  it('un rótulo KG guardado se resuelve al peldaño pack, no a la base del medio kilo', () => {
    const led = { unit_base: '500', rungs: { base: { label: '500' }, pack: { label: 'KG' }, box: { label: 'CJA' } } } as unknown as LadderParaRotulo;
    expect(rungDeRotulo('KG', led)).toBe('pack');
  });
});
