import {
  CADUCIDAD_UNIDADES, CADUCIDAD_UNIDADES_DEF, esCaducidadUnidad, unidadDesdeKepler, unidadEnTexto,
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

  it('esCaducidadUnidad acepta sólo las 7', () => {
    expect(CADUCIDAD_UNIDADES.every(esCaducidadUnidad)).toBe(true);
    expect(esCaducidadUnidad('cubeta')).toBe(false);
    expect(esCaducidadUnidad('Caja')).toBe(false);
    expect(esCaducidadUnidad(null)).toBe(false);
  });
});
