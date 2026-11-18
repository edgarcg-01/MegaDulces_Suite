import { factorExactoDeFicha, factorFichaKepler, frenoFichaSinCaja } from './ficha-kepler';

/**
 * `[PQ.19]` D24 — el factor de la ficha, con la misma regla que `analytics.v_kepler_unit_ladder`.
 * Los casos vienen de fichas reales documentadas en esa migración y en ERP_KEPLER §2.1.
 */
describe('[PQ.19] factorFichaKepler', () => {
  it('peldaño capturado: PAQ base, CJA ×12 en Unidad Dos', () => {
    expect(factorFichaKepler({ c11: 'PAQ', c80: 'CJA', c81: '12', c77: '10', c78: '120' })).toEqual({ unidad_base: 'PAQ', factor: 12 });
  });
  it('la caja es el peldaño de MAYOR factor aunque el último rotulado venga vacío (SKU 14030)', () => {
    expect(factorFichaKepler({ c11: 'PZA', c80: 'CJA', c81: '10', c83: 'PZA', c84: '0', c77: '5', c78: '50', c79: '0' }).factor).toBe(10);
  });
  it('sin factor capturado se deriva del costo (redondeado)', () => {
    expect(factorFichaKepler({ c11: 'PZA', c80: 'CJA', c81: '0', c77: '2.5', c78: '60.1' }).factor).toBe(24);
  });
  it('unidad única → factor 1', () => {
    expect(factorFichaKepler({ c11: ' kg ', c77: '30' })).toEqual({ unidad_base: 'KG', factor: 1 });
  });
  it('NEGATIVA: rotulado sin factor ni costo → null (ignorancia, no 1)', () => {
    expect(factorFichaKepler({ c11: 'PZA', c80: 'CJA', c81: '', c77: '5', c78: '' }).factor).toBeNull();
  });
  it('[PQ.87] peldaños que repiten la base (15151 Lico: PAQ ×1 al mismo costo) → unidad única, factor 1', () => {
    expect(factorFichaKepler({ c11: 'PAQ', c80: 'PAQ', c81: '1.00', c78: '30.45', c83: 'PAQ', c84: '1.00', c79: '30.45', c77: '30.45' }))
      .toEqual({ unidad_base: 'PAQ', factor: 1 });
  });
  it('[PQ.87] NEGATIVA: otro rótulo con factor 1 (PAQ / CJA ×1) sigue siendo ignorancia', () => {
    expect(factorFichaKepler({ c11: 'PAQ', c80: 'CJA', c81: '1.00', c78: '64.66', c77: '64.66' }).factor).toBeNull();
  });
  it('[PQ.87] NEGATIVA: mismo rótulo pero costo distinto de la base → no se afirma 1', () => {
    expect(factorFichaKepler({ c11: 'PAQ', c80: 'PAQ', c81: '1.00', c78: '20', c77: '30.45' }).factor).toBeNull();
  });
  it('NEGATIVA: sin unidad base → unidad_base null', () => {
    expect(factorFichaKepler({ c11: '  ' }).unidad_base).toBeNull();
  });
});

describe('[PQ.87][PQ.91] frenoFichaSinCaja', () => {
  const ficha = new Map([
    ['15151', { unidad_base: 'PAQ', factor: 1 }],
    ['32008', { unidad_base: 'PZA', factor: 14 }],
    ['99999', { unidad_base: 'PZA', factor: null }],
  ]);
  it('ficha sin caja y la Suite en cajas de 40 → rechaza nombrando SKU, unidad y caja', () => {
    const r = frenoFichaSinCaja([{ sku: '15151', piezas_por_caja: 40 }, { sku: '32008', piezas_por_caja: 14 }], ficha, '08');
    expect(r.motivo).toContain('15151 se compra por PAQ');
    expect(r.motivo).toContain('cajas de 40');
    expect(r.motivo).toContain('sucursal 08');
  });
  it('caja 1 en los dos lados → va en la unidad base de la ficha; la caja de 14 no se toca', () => {
    const r = frenoFichaSinCaja([{ sku: '15151', piezas_por_caja: 1 }, { sku: '32008', piezas_por_caja: 14 }], ficha, '08');
    expect(r.motivo).toBeNull();
    expect([...r.sinCaja]).toEqual([['15151', 'PAQ']]);
  });
  it('[PQ.91] sin factor de la Suite cuenta como 1 (antes salía en CJA, que la ficha no tiene)', () => {
    const r = frenoFichaSinCaja([{ sku: '15151', piezas_por_caja: null }, { sku: '15151b' }], ficha, '08');
    expect(r.motivo).toBeNull();
    expect(r.sinCaja.get('15151')).toBe('PAQ');
  });
  it('NEGATIVA: ficha que no dice su factor no frena ni cambia la unidad', () => {
    const r = frenoFichaSinCaja([{ sku: '99999', piezas_por_caja: 12 }], ficha, '08');
    expect(r).toEqual({ motivo: null, sinCaja: new Map() });
  });
});

/**
 * `[COT.45]` Las vistas truncan el factor (floor) y Kepler guarda decimales: fichas reales de Padre
 * Hidalgo, 2026-11-18 (95579 BTO ×19.75 · 97235 CJA ×10.80 en la Unidad Dos).
 */
describe('[COT.45] factorExactoDeFicha', () => {
  const bolsa = { u2: 'PAQ', f2: '1.00', u3: 'BTO', f3: '19.75' };
  const choco = { u2: 'CJA', f2: '10.80', u3: '', f3: '0.00' };
  it('la vista dijo 19 y la ficha 19.75 en esa presentación: 19.75', () => {
    expect(factorExactoDeFicha(19, 'BTO', bolsa)).toBe(19.75);
    expect(factorExactoDeFicha(10, 'cja', choco)).toBe(10.8);
  });
  it('si el entero no coincide, NO se mezcla con otra presentación: se queda la vista', () => {
    expect(factorExactoDeFicha(20, 'BTO', bolsa)).toBe(20);
    expect(factorExactoDeFicha(19, 'CJA', bolsa)).toBe(19);
  });
  it('factores enteros, sin ficha o sin factor: igual que antes', () => {
    expect(factorExactoDeFicha(24, 'CJA', { u2: 'PAQ', f2: '6', u3: 'CJA', f3: '24.00' })).toBe(24);
    expect(factorExactoDeFicha(19, 'BTO', null)).toBe(19);
    expect(factorExactoDeFicha(null, 'BTO', bolsa)).toBeNull();
  });
});
