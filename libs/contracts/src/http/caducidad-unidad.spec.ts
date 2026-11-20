import {
  CADUCIDAD_UNIDADES, CADUCIDAD_UNIDADES_DEF, esCaducidadUnidad, unidadDesdeKepler, unidadEnTexto,
  unidadesDesdePresentaciones, unidadesOfrecidas, factorDeCaptura, FEFO_MOTIVOS, esFefoMotivo,
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

describe('[P2.9 paso 4] factorDeCaptura: con qué factor entra a FEFO lo capturado (D4)', () => {
  // Producto real de prod (99734, plaza 06): base PAQ, ranura CJA de 24, escalera PZA SIN factor.
  const prod = unidadesDesdePresentaciones([
    { unidad: 'CJA', factor: 24, origen: 'ranura' }, { unidad: 'PAQ', factor: 1, origen: 'base' },
    { unidad: 'PZA', factor: null, origen: 'escalera' },
  ]).unidades;

  it('⭐ la base vale 1 y una caja de 24 paquetes vale 24 (45 cajas fechaban 45 paquetes hasta el paso 4)', () => {
    expect(factorDeCaptura(prod, 'paquete')).toEqual({ factor: 1, motivo: null });
    expect(factorDeCaptura(prod, 'caja')).toEqual({ factor: 24, motivo: null });
  });

  it('⛔ NEGATIVA — la escalera sin factor NO vale 1: no entra, y dice por qué', () => {
    expect(factorDeCaptura(prod, 'pieza')).toEqual({ factor: null, motivo: 'unidad_sin_factor' });
  });

  it('⛔ NEGATIVA — una unidad que el producto no tiene no se convierte (6 piezas de un producto PAQ no son 6 paquetes)', () => {
    const soloPaq = unidadesDesdePresentaciones([{ unidad: 'CJA', factor: 12, origen: 'ranura' }, { unidad: 'PAQ', factor: 1, origen: 'base' }]).unidades;
    expect(factorDeCaptura(soloPaq, 'pieza')).toEqual({ factor: null, motivo: 'unidad_fuera_del_producto' });
  });

  it('el kilo de un producto de bolsa de 500 g vale 2 bolsas (base × factor_KG = 1000, medido 51/51)', () => {
    const bolsa = unidadesDesdePresentaciones([{ unidad: '500', factor: 1, origen: 'base' }, { unidad: 'KG', factor: 2, origen: 'ranura' }]).unidades;
    expect(factorDeCaptura(bolsa, 'kg')).toEqual({ factor: 2, motivo: null });
    expect(factorDeCaptura(bolsa, 'g500')).toEqual({ factor: 1, motivo: null });
  });

  it('sin unidad, o sin lista del producto, no entra y el motivo dice cuál', () => {
    expect(factorDeCaptura(prod, null)).toEqual({ factor: null, motivo: 'sin_unidad' });
    expect(factorDeCaptura(null, 'caja')).toEqual({ factor: null, motivo: 'sin_presentaciones' });
    expect(factorDeCaptura([], 'caja', 'sin_lectura')).toEqual({ factor: null, motivo: 'sin_lectura' });
  });

  it('los motivos son los del CHECK de la migración 20261120172724', () => {
    expect(FEFO_MOTIVOS).toEqual([
      'sin_producto', 'sin_caducidad', 'sin_cantidad', 'sin_unidad',
      'sin_presentaciones', 'sin_lectura', 'unidad_fuera_del_producto', 'unidad_sin_factor',
      'sin_existencia_sin_fecha', 'existencia_sin_fecha_insuficiente',
    ]);
    expect(esFefoMotivo('unidad_sin_factor')).toBe(true);
    expect(esFefoMotivo('otro')).toBe(false);
  });
});
