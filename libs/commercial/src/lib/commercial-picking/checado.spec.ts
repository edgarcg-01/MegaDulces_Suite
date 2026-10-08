// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver la nota de `allocation.spec.ts`).
import { cuadraChecado, estadoRenglon, etiquetasCJ } from './checado.service';

/** `[GP.4]` Las reglas del checado que deciden qué sale y qué etiquetas se imprimen. */
describe('cuadraChecado', () => {
  it('piezas: exacto', () => {
    expect(cuadraChecado(12, 12, false)).toBe(true);
    expect(cuadraChecado(12, 11, false)).toBe(false);
  });

  it('⭐ kilos: la báscula no da el gramo de Kepler, medio por ciento de holgura', () => {
    expect(cuadraChecado(50, 50.2, true)).toBe(true);
  });

  it('prueba negativa del peso: 2% de diferencia no cuadra', () => {
    expect(cuadraChecado(50, 51, true)).toBe(false);
  });
});

describe('estadoRenglon', () => {
  it.each([
    [10, 0, 'pendiente'],
    [10, 4, 'falta'],
    [10, 10, 'completo'],
    [10, 11, 'sobra'],
  ] as const)('esperado %s, checado %s → %s', (e, c, est) => {
    expect(estadoRenglon(e, c, false)).toBe(est);
  });
});

describe('etiquetasCJ · "1/7 … 7/7" sobre todo el pedido', () => {
  it('⭐ numera corrido entre productos y el total es el del pedido', () => {
    const et = etiquetasCJ([
      { sku: '06001', producto: 'SNICKERS', unidad: 'CJA', cajas: 2 },
      { sku: '78158', producto: 'LECHITA', unidad: 'CJA', cajas: 1 },
    ]);
    expect(et.map((e) => `${e.n}/${e.total} ${e.sku}`)).toEqual(['1/3 06001', '2/3 06001', '3/3 78158']);
  });

  it('sin cajas no hay etiquetas', () => {
    expect(etiquetasCJ([{ sku: 'x', producto: 'x', unidad: 'CJA', cajas: 0 }])).toEqual([]);
  });
});
