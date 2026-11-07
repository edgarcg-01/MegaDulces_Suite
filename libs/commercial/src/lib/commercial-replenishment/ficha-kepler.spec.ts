import { factorFichaKepler } from './ficha-kepler';

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
