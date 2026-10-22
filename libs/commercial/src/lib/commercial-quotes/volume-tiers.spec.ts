import {
  escaleraDisjunta, tramoDeCantidad, aCentavosPorBase,
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
