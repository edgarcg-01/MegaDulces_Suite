import { describe, it, expect } from 'vitest';
import { desgloseDescuento, type RenglonParaDesglose } from './quote-discount-breakdown';

/**
 * `[E.27]` Casos reales del motor contra prod (2026-10-22, `checkQuote`):
 *   · 89008 × 38 PAQ: lista 55.93 → unidad mayor 51.7558 → volumen de la caja 50.8483 → $50.85
 *   · 70001 × 3 PAQ: lista 87.14 → volumen 80.47
 */
const r89008: RenglonParaDesglose = {
  quantity: 38, unit_price: 50.85, list_price: 51.7558, line_total: 1932.3,
  pasos: [
    { step: 'lista', before: null, after: 55.93 },
    { step: 'unidad_mayor', before: 55.93, after: 51.7558 },
    { step: 'volumen_unidad_mayor', before: 51.7558, after: 50.8483 },
  ],
};
const r70001: RenglonParaDesglose = {
  quantity: 3, unit_price: 80.47, list_price: 87.14, line_total: 241.41,
  pasos: [{ step: 'lista', before: null, after: 87.14 }, { step: 'volumen', before: 87.14, after: 80.47 }],
};

describe('desgloseDescuento', () => {
  it('cierra EXACTO: lista − mecanismos ± redondeo = importe guardado', () => {
    const d = desgloseDescuento([r89008, r70001]);
    expect(d.lista).toBe(2125.34 + 261.42);
    expect(d.unidad_mayor).toBe(158.62);
    // 38 × 0.9075 = 34.485 → 34.48 en flotante; el medio centavo lo absorbe la línea de redondeo
    expect(d.volumen).toBe(54.49);
    expect(d.importe).toBe(2173.71);
    const cierra = d.lista - d.unidad_mayor - d.volumen - d.promocion - d.sin_desglose + d.redondeo;
    expect(Math.round(cierra * 100)).toBe(Math.round(d.importe * 100));
    expect(Math.abs(d.redondeo)).toBeLessThan(0.5); // redondeo a centavos, no un mecanismo escondido
  });

  it('un renglón cuyo precio cambió en Kepler va a «sin desglose», con lo guardado', () => {
    const d = desgloseDescuento([{ ...r70001, unit_price: 80.28, line_total: 240.84, pasos: null }]);
    expect(d.renglones_sin_desglose).toBe(1);
    expect(d.volumen).toBe(0);
    expect(d.sin_desglose).toBe(20.58); // 3 × (87.14 − 80.28)
    expect(d.lista - d.sin_desglose + d.redondeo).toBeCloseTo(d.importe, 2);
  });

  it('un tramo MÁS CARO que la lista sale negativo (es un recargo, no se esconde)', () => {
    const d = desgloseDescuento([{
      quantity: 5, unit_price: 514.4, list_price: 479.82, line_total: 2572,
      pasos: [{ step: 'lista', before: null, after: 479.82 }, { step: 'volumen', before: 479.82, after: 514.4 }],
    }]);
    expect(d.volumen).toBe(-172.9);
  });

  it('un renglón sin precio no entra (ni al importe ni a la lista)', () => {
    const d = desgloseDescuento([{ quantity: 4, unit_price: null, list_price: null, line_total: 0, pasos: null }, r70001]);
    expect(d.renglones).toBe(1);
    expect(d.importe).toBe(241.41);
  });
});
