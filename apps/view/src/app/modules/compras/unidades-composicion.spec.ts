import { componerEnUnidades } from './unidades-composicion';

const PAQ_CJA = [{ unidad: 'PAQ', factorBase: 1 }, { unidad: 'CJA', factorBase: 20 }];
const PZA_PAQ_CJA = [{ unidad: 'PZA', factorBase: 1 }, { unidad: 'PAQ', factorBase: 10 }, { unidad: 'CJA', factorBase: 180 }];

describe('componerEnUnidades', () => {
  it('1,305 PAQ con caja de 20 → 65 CJA 5 PAQ', () => {
    expect(componerEnUnidades(1305, PAQ_CJA)).toEqual([{ cantidad: 65, unidad: 'CJA' }, { cantidad: 5, unidad: 'PAQ' }]);
  });

  it('606.9 PAQ → 30 CJA 6.9 PAQ (el decimal queda en la menor, sin ruido de coma flotante)', () => {
    expect(componerEnUnidades(606.9, PAQ_CJA)).toEqual([{ cantidad: 30, unidad: 'CJA' }, { cantidad: 6.9, unidad: 'PAQ' }]);
  });

  it('1,000 PZA con paquete de 10 y caja de 180 → 5 CJA 10 PAQ (sin «0 PZA»)', () => {
    expect(componerEnUnidades(1000, PZA_PAQ_CJA)).toEqual([{ cantidad: 5, unidad: 'CJA' }, { cantidad: 10, unidad: 'PAQ' }]);
  });

  it('menos de una caja se queda en la base: 5 PAQ → [5 PAQ]', () => {
    expect(componerEnUnidades(5, PAQ_CJA)).toEqual([{ cantidad: 5, unidad: 'PAQ' }]);
  });

  it('0 → [] (no inventa «0 CJA»)', () => {
    expect(componerEnUnidades(0, PAQ_CJA)).toEqual([]);
  });

  it('el orden de entrada no importa', () => {
    expect(componerEnUnidades(1305, [...PAQ_CJA].reverse())).toEqual(componerEnUnidades(1305, PAQ_CJA));
  });

  it('negativo: no se parte en cajas, se dice tal cual en la unidad menor', () => {
    expect(componerEnUnidades(-3, PAQ_CJA)).toEqual([{ cantidad: -3, unidad: 'PAQ' }]);
  });

  it('sin unidades válidas o cantidad no finita → []', () => {
    expect(componerEnUnidades(10, [])).toEqual([]);
    expect(componerEnUnidades(10, [{ unidad: 'CJA', factorBase: 0 }])).toEqual([]);
    expect(componerEnUnidades(Number.NaN, PAQ_CJA)).toEqual([]);
  });
});
