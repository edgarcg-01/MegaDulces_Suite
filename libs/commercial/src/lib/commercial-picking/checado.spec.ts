// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver la nota de `allocation.spec.ts`).
import { cantidadEnUnidad, cuadraChecado, estadoRenglon, etiquetasCJ, excede, textosRenglon, type RenglonParaTexto } from './checado.service';

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

describe('excede · lo que sobra no se cuenta', () => {
  it('⭐ ya iban 384 de 384: otra caja excede (no se registra, se regresa)', () => {
    expect(excede(384, 384, 192, false)).toBe(true);
  });

  it('completar lo que falta no excede', () => {
    expect(excede(384, 192, 192, false)).toBe(false);
  });

  it('en kilos, pasarse por menos de medio por ciento no excede', () => {
    expect(excede(50, 49.9, 0.3, true)).toBe(false);
  });

  it('prueba negativa del peso: pasarse 4% sí excede', () => {
    expect(excede(50, 50, 2, true)).toBe(true);
  });
});

describe('cantidadEnUnidad · en la unidad PEDIDA (Francisco, 2026-10-10)', () => {
  it.each([
    [40, 'PZA', 'BOL', 20, '2 BOL'],
    [20, 'PZA', 'BOL', 20, '1 BOL'],
    [45, 'PZA', 'BOL', 20, '2 BOL + 5 PZA'],
    [5, 'PZA', 'BOL', 20, '5 PZA'],
    [0, 'PZA', 'BOL', 20, '0 BOL'],
    [1200, 'PZA', 'CJA', 600, '2 CJA'],
    [2.5, 'KG', 'KG', 1, '2.5 KG'],
  ] as const)('%s %s pedido en %s (de %s) → %s', (base, ub, up, f, txt) => {
    expect(cantidadEnUnidad(base, ub, up, f)).toBe(txt);
  });

  it('prueba negativa: sin unidad pedida se queda en la base (no inventa una)', () => {
    expect(cantidadEnUnidad(40, 'PZA', null, null)).toBe('40 PZA');
    expect(cantidadEnUnidad(40, 'PZA', 'BOL', null)).toBe('40 PZA');
  });
});

describe('textosRenglon · lo que dice la pantalla del checado', () => {
  const L = (o: Partial<RenglonParaTexto> = {}): RenglonParaTexto => ({
    esperado: 40, checado: 0, unidad: 'PZA', unidad_pedida: 'BOL', factor_pedida: 20,
    unidad_mayor: 'CJA', factor_mayor: 240, esperado_mayor: null, checado_mayor: 0, checado_sueltas: 0, estado: 'pendiente', ...o,
  });

  it('⭐ bolsa: "Pedido 2 BOL · Llevas 1 BOL · Faltan 1 BOL" (antes decía 40 / 20 PZA)', () => {
    expect(textosRenglon(L({ checado: 20, checado_sueltas: 20, estado: 'falta' }))).toEqual({
      pedido_texto: '2 BOL', llevas_texto: '1 BOL', diferencia_texto: 'Faltan 1 BOL',
    });
  });

  it('⭐ caja pedida: distingue las cajas cerradas de lo suelto (de eso salen las etiquetas 1/N)', () => {
    const t = textosRenglon(L({
      esperado: 1200, checado: 1200, unidad_pedida: 'CJA', factor_pedida: 600, factor_mayor: 600, esperado_mayor: 2,
      checado_mayor: 1, checado_sueltas: 600, estado: 'completo',
    }));
    expect(t).toEqual({ pedido_texto: '2 CJA', llevas_texto: '1 CJA + 600 PZA', diferencia_texto: null });
  });

  it('lo que sobra también en la unidad pedida', () => {
    expect(textosRenglon(L({ checado: 60, estado: 'sobra' })).diferencia_texto).toBe('Sobran 1 BOL');
  });

  it('sin unidad pedida (surtido anterior a GP.3) usa la caja si lo esperado da cajas enteras', () => {
    const t = textosRenglon(L({ esperado: 480, unidad_pedida: null, factor_pedida: null, esperado_mayor: 2 }));
    expect(t.pedido_texto).toBe('2 CJA');
    expect(t.llevas_texto).toBe('0 CJA');
  });
});
