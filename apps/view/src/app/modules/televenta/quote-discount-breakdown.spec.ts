import { describe, it, expect } from 'vitest';
import { desgloseDescuento, type RenglonParaDesglose } from './quote-discount-breakdown';

/**
 * `[E.27]`/`[E.28]` Renglones reales, capturados como los captura Kepler (por presentación):
 *   · 89008 × 36 PAQ: lista 55.93 → tramo 10+ del PAQ 51.76 (la captura de la pantalla de Kepler)
 *   · 89008 × 2 CJA: lista 621.07 → se cobra 24 × 51.76 = 1,242.24 (UD40 01-0002353)
 *   · 70001 × 3 PAQ: lista 87.14 → volumen 80.47
 */
const r36paq: RenglonParaDesglose = {
  quantity: 36, unit_price: 51.76, list_price: 55.93, line_total: 1863.36,
  pasos: [{ step: 'lista', before: null, after: 55.93 }, { step: 'volumen', before: 55.93, after: 51.76 }],
};
const r2cja: RenglonParaDesglose = {
  quantity: 2, unit_price: 621.12, list_price: 621.07, line_total: 1242.24,
  pasos: [{ step: 'lista', before: null, after: 621.07 }],
};
const r70001: RenglonParaDesglose = {
  quantity: 3, unit_price: 80.47, list_price: 87.14, line_total: 241.41,
  pasos: [{ step: 'lista', before: null, after: 87.14 }, { step: 'volumen', before: 87.14, after: 80.47 }],
};

describe('desgloseDescuento', () => {
  it('cierra EXACTO: lista − mecanismos ± redondeo = importe guardado', () => {
    const d = desgloseDescuento([r36paq, r2cja, r70001]);
    expect(d.lista).toBeCloseTo(2013.48 + 1242.14 + 261.42, 2);
    expect(d.volumen).toBeCloseTo(150.12 + 20.01, 2);
    expect(d.importe).toBeCloseTo(1863.36 + 1242.24 + 241.41, 2);
    const cierra = d.lista - d.volumen - d.promocion - d.sin_desglose + d.redondeo;
    expect(Math.round(cierra * 100)).toBe(Math.round(d.importe * 100));
  });

  it('la caja se cobra por unidad base a centavos: el +$0.10 sale como redondeo, no como mecanismo', () => {
    const d = desgloseDescuento([r2cja]);
    expect(d.redondeo).toBe(0.1);
    expect(d.volumen).toBe(0);
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
      quantity: 50, unit_price: 12.76, list_price: 11.99, line_total: 638,
      pasos: [{ step: 'lista', before: null, after: 11.99 }, { step: 'volumen', before: 11.99, after: 12.76 }],
    }]);
    expect(d.volumen).toBe(-38.5);
  });

  it('un renglón sin precio no entra (ni al importe ni a la lista)', () => {
    const d = desgloseDescuento([{ quantity: 4, unit_price: null, list_price: null, line_total: 0, pasos: null }, r70001]);
    expect(d.renglones).toBe(1);
    expect(d.importe).toBe(241.41);
  });
});
