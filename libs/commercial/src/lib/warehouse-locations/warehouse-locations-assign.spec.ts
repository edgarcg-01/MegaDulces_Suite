import { limpiarEscalera } from './warehouse-locations-assign.service';

const f = (peldano: number, rotulo: string | null, factor: number | null, fuente: 'base' | 'capturado' | 'derivado_del_costo' | 'sin_factor', extra: Record<string, unknown> = {}) => ({
  peldano, rotulo, factor, fuente, codigos: [] as string[], factor_source: 'capturado', peldano_caja: null as number | null, ...extra,
});

/**
 * `[UB.3]` La escalera que se ofrece al asignar. Casos medidos en prod (PH, 2026-10-10): de 9,656
 * fichas, 2,661 traen un peldaño sin factor que REPITE el rótulo de otro (fantasma de captura) y 17
 * traen uno sin factor con rótulo propio (presentación real sin conversión).
 */
describe('[UB.3] limpiar la escalera de Kepler', () => {
  it('70243 (PH): PAQ base · PAQ fantasma sin factor · CJA ×20 → se ofrecen PAQ y CJA', () => {
    const r = limpiarEscalera([f(1, 'PAQ', 1, 'base', { peldano_caja: 3 }), f(2, 'PAQ', null, 'sin_factor', { peldano_caja: 3 }), f(3, 'CJA', 20, 'capturado', { peldano_caja: 3 })]);
    expect(r.presentaciones.map((p) => [p.peldano, p.rotulo, p.factor, p.es_caja])).toEqual([[1, 'PAQ', 1, false], [3, 'CJA', 20, true]]);
  });

  it('un peldaño sin factor con rótulo PROPIO sí se ofrece, con factor null (no medido, nunca 0)', () => {
    const r = limpiarEscalera([f(1, 'PZA', 1, 'base'), f(2, 'EXH', null, 'sin_factor')]);
    expect(r.presentaciones.map((p) => [p.peldano, p.factor])).toEqual([[1, 1], [2, null]]);
  });

  it('un producto de una sola presentación no tiene «caja»', () => {
    expect(limpiarEscalera([f(1, 'KG', 1, 'base')]).presentaciones[0].es_caja).toBe(false);
  });

  it('la caja es la de MAYOR factor aunque Kepler no diga el peldaño (no la última rotulada)', () => {
    const r = limpiarEscalera([f(1, 'PZA', 1, 'base'), f(2, 'CJA', 24, 'capturado'), f(3, 'PAQ', 6, 'capturado')]);
    expect(r.presentaciones.find((p) => p.es_caja)?.peldano).toBe(2);
  });

  it('si Kepler marca que el factor contradice al costo, se avisa', () => {
    const r = limpiarEscalera([f(1, 'PZA', 1, 'base', { factor_source: 'capturado_contradice_al_costo' }), f(2, 'CJA', 12, 'capturado', { factor_source: 'capturado_contradice_al_costo' })]);
    expect(r.aviso).toContain('contradice');
  });

  it('la vista cae en peldano_caja = 1 cuando no encuentra caja: la base NUNCA se marca como caja', () => {
    const r = limpiarEscalera([f(1, 'PZA', 1, 'base', { peldano_caja: 1 }), f(2, 'EXH', null, 'sin_factor', { peldano_caja: 1 })]);
    expect(r.presentaciones.some((p) => p.es_caja)).toBe(false);
  });

  it('peldano_caja apuntando a un peldaño SIN factor no gana: la caja es la de mayor factor > 1', () => {
    const r = limpiarEscalera([f(1, 'PZA', 1, 'base', { peldano_caja: 2 }), f(2, 'EXH', null, 'sin_factor', { peldano_caja: 2 }), f(3, 'CJA', 12, 'capturado', { peldano_caja: 2 })]);
    expect(r.presentaciones.filter((p) => p.es_caja).map((p) => p.peldano)).toEqual([3]);
  });

  it('peldano_caja vivo y con factor se respeta aunque otro peldaño tenga más factor', () => {
    const r = limpiarEscalera([f(1, 'PZA', 1, 'base', { peldano_caja: 2 }), f(2, 'CJA', 24, 'capturado', { peldano_caja: 2 }), f(3, 'BUL', 48, 'capturado', { peldano_caja: 2 })]);
    expect(r.presentaciones.find((p) => p.es_caja)?.peldano).toBe(2);
  });

  it('los códigos de barras repetidos entre columnas de Kepler salen UNA vez', () => {
    const r = limpiarEscalera([f(1, 'PZA', 1, 'base', { codigos: ['7501', '7501', '7502'] })]);
    expect(r.presentaciones[0].codigos).toEqual(['7501', '7502']);
  });
});
