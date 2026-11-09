import { factorFichaKepler, frenoFichaSinCaja } from './ficha-kepler';

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
