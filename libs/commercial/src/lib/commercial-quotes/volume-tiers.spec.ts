import {
  escaleraDisjunta, tramoDeCantidad, aCentavosPorBase, tramosAplicables,
  type VolumeTier,
} from './quote-pricing.service';

/**
 * `[E.22]` El tramo de volumen que Kepler cobra. Caso real (2026-10-21): SKU 89008 en la 01/08,
 * 36 PAQ cobrados a $51.76 en Kepler y cotizados a $55.00 en la Suite (el motor sólo conocía el
 * primer tramo). Escalera de `kdpv_prod_util`, tal cual está en prod.
 */
const PAQ_89008: VolumeTier[] = [
  { desde: 10, hasta: 999999, price: 51.76 },
  { desde: 3, hasta: 5, price: 55.0 },
  { desde: 6, hasta: 9, price: 53.16 },
];

describe('escalera de volumen del ERP', () => {
  it('89008: cada cantidad cobra el tramo que la contiene (lo que Kepler cobró, 120 d)', () => {
    const t = escaleraDisjunta(PAQ_89008)!;
    expect(tramoDeCantidad(t, 2)).toBeNull(); // abajo del primer tramo: lista $55.93
    expect(tramoDeCantidad(t, 4)?.price).toBe(55.0);
    expect(tramoDeCantidad(t, 7)?.price).toBe(53.16);
    expect(tramoDeCantidad(t, 36)?.price).toBe(51.76);
    expect(tramoDeCantidad(t, 38)?.price).toBe(51.76); // la COT-2026-00026 cotizó $55.00
  });

  it('tramos encimados no son escalera: son niveles por transacción y no se derivan (§2.7)', () => {
    expect(escaleraDisjunta([
      { desde: 10, hasta: 999999, price: 71.15 },
      { desde: 10, hasta: 999999, price: 70.51 },
    ])).toBeNull();
    expect(escaleraDisjunta([{ desde: 3, hasta: 10, price: 5 }, { desde: 10, hasta: 20, price: 4 }])).toBeNull();
  });

  it('una cantidad en un hueco entre tramos no toma ninguno (no se adivina)', () => {
    const t = escaleraDisjunta([{ desde: 3, hasta: 5, price: 9 }, { desde: 10, hasta: 99, price: 8 }])!;
    expect(tramoDeCantidad(t, 7)).toBeNull();
  });
});

/**
 * `[COT.7.0d]` Escalera ENCIMADA: rige el nivel 0. Caso real: 03004 PAQ en la 01, tal cual en
 * `kdpv_prod_util` (2026-11-03). El pedido TELEMARK 0003668 cobró 10 PAQ a $39.83 (nivel 0); el
 * motor cotizaba $36.02 porque, sin tramos, caía al volumen aplastado de `v_label_prices`.
 */
const PAQ_03004: VolumeTier[] = [
  { desde: 3, hasta: 999999, price: 39.83, nivel: 0 },
  { desde: 3, hasta: 5, price: 36.02, nivel: 1 },
  { desde: 6, hasta: 9, price: 35.17, nivel: 2 },
  { desde: 10, hasta: 999999, price: 34.14, nivel: 3 },
];

describe('[COT.7.0d] tramosAplicables', () => {
  it('03004: encimada → los tramos del nivel 0, y 10 PAQ cobra $39.83 como Kepler', () => {
    const t = tramosAplicables(PAQ_03004)!;
    expect(t).toEqual([{ desde: 3, hasta: 999999, price: 39.83, nivel: 0 }]);
    expect(tramoDeCantidad(t, 10)?.price).toBe(39.83);
    expect(tramoDeCantidad(t, 2)).toBeNull(); // abajo del tramo: lista
  });

  it('disjunta → la escalera completa, el nivel no se mira (89008 sigue igual)', () => {
    expect(tramosAplicables(PAQ_89008)).toEqual(escaleraDisjunta(PAQ_89008));
  });

  it('encimada SIN nivel 0 → ninguna (niveles por transacción, no se derivan)', () => {
    expect(tramosAplicables([
      { desde: 10, hasta: 999999, price: 71.15, nivel: 1 },
      { desde: 10, hasta: 999999, price: 70.51, nivel: 2 },
    ])).toBeNull();
  });
});

/**
 * `[E.28]` Kepler guarda el precio de una presentación POR UNIDAD BASE a centavos (`kdm2.c12`) y el
 * importe es cantidad base × ese precio (`c13 = c9 × c12`). Renglones reales de pedidos U-D-40.
 * (Reemplaza la «unidad mayor que cabe» de E.23: Kepler no prorratea solo — cobra la presentación
 * que se captura, `kdm2.c55`; el prorrateo que se midió eran renglones capturados en CJA.)
 */
describe('precio de una presentación, a centavos por unidad base (kdm2.c12)', () => {
  it('63004: 1 CJA de 24 PAQ a lista $753.09 → 24 × $31.38 = $753.12, como lo cobró Kepler', () => {
    expect(aCentavosPorBase(753.09, 24, 1)).toEqual({ unit_price: 753.12, line_total: 753.12 });
  });

  it('89008: 2 CJA de 12 PAQ a $621.07 → 24 × $51.76 = $1,242.24 (UD40 01-0002353)', () => {
    expect(aCentavosPorBase(621.07, 12, 2)).toEqual({ unit_price: 621.12, line_total: 1242.24 });
  });

  it('en la unidad base no hay conversión: 36 PAQ a $51.76 = $1,863.36 (la captura del 89008)', () => {
    expect(aCentavosPorBase(51.76, 1, 36)).toEqual({ unit_price: 51.76, line_total: 1863.36 });
  });

  it('78401: 1 CJA con promo 3 % — se redondea la caja ($390.66) y luego la base: 12 × $32.56', () => {
    expect(aCentavosPorBase(402.74 * 0.97, 12, 1)).toEqual({ unit_price: 390.72, line_total: 390.72 });
    // NEGATIVO: dividir el precio con promo sin redondear la caja da $32.55 por PAQ
    expect(Math.round((402.74 * 0.97 / 12 + Number.EPSILON) * 100) / 100).toBe(32.55);
  });

  it('70079: 4 CJA de 12 PAQ al tramo $961.02 → 80.085 redondea a $80.09 (decimal), 48 × 80.09', () => {
    expect(aCentavosPorBase(961.02, 12, 4)).toEqual({ unit_price: 961.08, line_total: 3844.32 });
    // NEGATIVO: el redondeo binario de antes daba $80.08
    expect(Math.round((961.02 / 12 + Number.EPSILON) * 100) / 100).toBe(80.08);
  });

  it('NEGATIVO: redondear la caja y no la unidad base da el importe que Kepler NO cobra', () => {
    expect(Math.round(753.09 * 1 * 100) / 100).not.toBe(aCentavosPorBase(753.09, 24, 1).line_total);
  });
});
