import {
  CADUCIDAD_UNIDADES, CADUCIDAD_UNIDADES_DEF, esCaducidadUnidad, unidadDesdeKepler, unidadEnTexto,
  unidadesDesdePresentaciones, unidadesOfrecidas,
} from './caducidad-unidad.contract';

describe('[P2.9 paso 1] caducidad-unidad: una sola definición de las 7 unidades', () => {
  it('son las 7 que pidió el PM, en orden, y cada una dice su rótulo de Kepler', () => {
    expect(CADUCIDAD_UNIDADES).toEqual(['pieza', 'paquete', 'caja', 'bulto', 'kg', 'g250', 'g500']);
    expect(CADUCIDAD_UNIDADES_DEF.map((d) => d.kepler)).toEqual(['PZA', 'PAQ', 'CJA', 'BTO', 'KG', '250', '500']);
  });

  it('etiquetas y plurales en español (no «g250s»)', () => {
    const e = Object.fromEntries(CADUCIDAD_UNIDADES_DEF.map((d) => [d.codigo, d.etiqueta]));
    expect(e).toEqual({ pieza: 'Pieza', paquete: 'Paquete', caja: 'Caja', bulto: 'Bulto', kg: 'Kg', g250: '250 g', g500: '500 g' });
    expect(unidadEnTexto(3, 'paquete')).toBe('paquetes');
    expect(unidadEnTexto(1, 'caja')).toBe('caja');
    expect(unidadEnTexto(2.5, 'kg')).toBe('kg');
    expect(unidadEnTexto(4, 'g250')).toBe('bolsas de 250 g');
    expect(unidadEnTexto(1, 'g500')).toBe('bolsa de 500 g');
  });

  it('un renglón viejo sin unidad dice «pz»; un código desconocido se muestra crudo, no se traduce', () => {
    expect(unidadEnTexto(3, null)).toBe('pz');
    expect(unidadEnTexto(3, 'cubeta')).toBe('cubeta');
  });

  it('⛔ NEGATIVA (D2) — un código PAQ sugiere PAQUETE, ya no «caja»', () => {
    expect(unidadDesdeKepler('PAQ', 1)).toBe('paquete');
    expect(unidadDesdeKepler('paq', null)).toBe('paquete');
  });

  it('tabla Kepler → unidad de la hoja', () => {
    expect(unidadDesdeKepler('PZA', 1)).toBe('pieza');
    expect(unidadDesdeKepler('CJA', 24)).toBe('caja');
    expect(unidadDesdeKepler('KG', null)).toBe('kg');
    expect(unidadDesdeKepler('BTO', 20)).toBe('bulto');
    expect(unidadDesdeKepler('250', 4)).toBe('g250');
    expect(unidadDesdeKepler('500', 2)).toBe('g500');
  });

  it('sin unidad declarada: el factor todavía dice algo; sin unidad ni factor, no inventa', () => {
    expect(unidadDesdeKepler(null, 12)).toBe('caja');
    expect(unidadDesdeKepler('', 1)).toBe('pieza');
    expect(unidadDesdeKepler(null, null)).toBeNull();
    expect(unidadDesdeKepler('SER', null)).toBeNull();
  });

  it('[paso 3] presentaciones → unidades: base 500 con ranura KG da «500 g» y «kg», con la base marcada', () => {
    const r = unidadesDesdePresentaciones([
      { unidad: '500', factor: 1, origen: 'base' },
      { unidad: 'KG', factor: 2, origen: 'ranura' },
    ]);
    expect(r.unidades?.map((u) => u.codigo)).toEqual(['kg', 'g500']);
    expect(r.base).toBe('g500');
    expect(r.fuera_de_las_7).toEqual([]);
  });

  it('[paso 3] PAQ + CJA + escalera PZA: tres unidades, en el orden del contrato; la escalera llega SIN factor y queda null', () => {
    const r = unidadesDesdePresentaciones([
      { unidad: 'CJA', factor: '12', origen: 'ranura' },
      { unidad: 'PAQ', factor: null, origen: 'base' },
      { unidad: 'PZA', factor: null, origen: 'escalera' },
    ]);
    expect(r.unidades).toEqual([
      { codigo: 'pieza', kepler: 'PZA', factor: null, base: false },
      { codigo: 'paquete', kepler: 'PAQ', factor: 1, base: true },
      { codigo: 'caja', kepler: 'CJA', factor: 12, base: false },
    ]);
  });

  it('[paso 3] el mismo código por dos caminos: gana el que trae factor (ranura CJA 12 sobre escalera CJA sin factor)', () => {
    const r = unidadesDesdePresentaciones([
      { unidad: 'CJA', factor: null, origen: 'escalera' },
      { unidad: 'CJA', factor: 12, origen: 'ranura' },
    ]);
    expect(r.unidades).toEqual([{ codigo: 'caja', kepler: 'CJA', factor: 12, base: false }]);
  });

  it('⛔ NEGATIVA [paso 3] — un rótulo fuera de las 7 NO se traduce por su factor (CUB de 20 no es «caja»)', () => {
    const r = unidadesDesdePresentaciones([
      { unidad: 'CUB', factor: 1, origen: 'base' },
      { unidad: 'SER', factor: 20, origen: 'ranura' },
    ]);
    expect(r.unidades).toBeNull();
    expect(r.base).toBeNull();
    expect(r.fuera_de_las_7).toEqual(['CUB', 'SER']);
  });

  it('[paso 3] el selector: producto con 2 unidades ofrece 2; sin lista ofrece las 7; «otra unidad» abre las 7', () => {
    const prod = { unidades: unidadesDesdePresentaciones([
      { unidad: 'PAQ', factor: 1, origen: 'base' }, { unidad: 'CJA', factor: 12, origen: 'ranura' },
    ]).unidades };
    expect(unidadesOfrecidas(prod, false).map((d) => d.codigo)).toEqual(['paquete', 'caja']);
    expect(unidadesOfrecidas(null, false)).toHaveLength(7);
    expect(unidadesOfrecidas({ unidades: null }, false)).toHaveLength(7);
    expect(unidadesOfrecidas(prod, true)).toHaveLength(7);
  });

  it('[paso 3] lo que ya está marcado nunca desaparece del selector (renglón viejo en «pieza» de un producto PAQ/CJA)', () => {
    const prod = { unidades: unidadesDesdePresentaciones([
      { unidad: 'PAQ', factor: 1, origen: 'base' }, { unidad: 'CJA', factor: 12, origen: 'ranura' },
    ]).unidades };
    expect(unidadesOfrecidas(prod, false, ['pieza', null]).map((d) => d.codigo)).toEqual(['pieza', 'paquete', 'caja']);
  });

  it('esCaducidadUnidad acepta sólo las 7', () => {
    expect(CADUCIDAD_UNIDADES.every(esCaducidadUnidad)).toBe(true);
    expect(esCaducidadUnidad('cubeta')).toBe(false);
    expect(esCaducidadUnidad('Caja')).toBe(false);
    expect(esCaducidadUnidad(null)).toBe(false);
  });
});
