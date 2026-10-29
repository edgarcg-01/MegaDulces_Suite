import { claseDeClave, folioHoja, leerFolioHoja, zonaDeSucursal, ZONAS_HOJA_GASTOS } from './hoja-gastos.contract';

describe('[CGA-A.65] el folio de la hoja en la referencia de CAOS (texto libre)', () => {
  it.each([
    ['gnf morelia HG-12', 12],
    ['hg12', 12],
    ['HG 12 morelia', 12],
    ['hg - 7', 7],
    ['reposicion hg-123456', 123456],
  ])('«%s» → %s', (ref, n) => {
    expect(leerFolioHoja(ref)).toBe(n);
  });

  it('NEGATIVA: sin folio, o con «hg» pegado a otra palabra, no hay hoja', () => {
    for (const ref of ['gnf morelia', 'gnf ma', 'thg12', 'hg', 'hg-', 'hg1234567', '', null, undefined]) {
      expect(leerFolioHoja(ref as string | null | undefined)).toBeNull();
    }
  });

  it('NEGATIVA: dos folios distintos en la misma referencia no se elige ninguno; el mismo dos veces, sí', () => {
    expect(leerFolioHoja('hg-12 y hg-13')).toBeNull();
    expect(leerFolioHoja('HG-12 hg12')).toBe(12);
  });

  it('el folio que se escribe es el que se lee', () => {
    expect(leerFolioHoja(`gnf morelia ${folioHoja(41)}`)).toBe(41);
  });
});

describe('[CGA-A.65] la clase del renglón sale de la clave del beneficiario en Kepler', () => {
  it('C… es proveedor, G… es gasto, sin clave se dice', () => {
    expect(claseDeClave('CB013')).toBe('proveedor');
    expect(claseDeClave(' gg015 ')).toBe('gasto');
    expect(claseDeClave('GNFC003')).toBe('gasto');
    expect(claseDeClave(null)).toBe('sin_clave');
    expect(claseDeClave('TI001')).toBe('sin_clave');
  });
});

describe('[CGA-A.65] las zonas', () => {
  it('Morelia es Abastos y Madero, en ese orden (el de la hoja en papel); Canindo, sola', () => {
    expect(zonaDeSucursal('07')?.clave).toBe('morelia');
    expect(zonaDeSucursal('08')?.sucursales).toEqual(['08', '07']);
    expect(zonaDeSucursal('06')?.clave).toBe('canindo');
    expect(zonaDeSucursal('01')).toBeNull();
  });

  it('una sucursal está en una sola zona', () => {
    const todas = ZONAS_HOJA_GASTOS.flatMap((z) => z.sucursales);
    expect(new Set(todas).size).toBe(todas.length);
  });
});
