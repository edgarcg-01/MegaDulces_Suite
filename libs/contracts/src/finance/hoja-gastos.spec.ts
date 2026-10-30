import { claseDeClave, folioHoja, leerFolioHoja, revisarConteoCajon, textoConteoCajon, zonaDeSucursal, ZONAS_HOJA_GASTOS } from './hoja-gastos.contract';

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

describe('[CGA-A.65] pagar con el cajón exige contar lo que sale (Edgar, 2026-10-30)', () => {
  // La hoja HG-1 de Morelia: $83,981.89 pagados con el cajón sin conteo.
  const HG1 = { piezas: { '1000': 83, '500': 1, '200': 2, '50': 1, '20': 1, '10': 1, '1': 1, '0.5': 1 }, morralla: 0.39 };

  it('cuadra al centavo: billetes, monedas y la morralla de menos de 50¢', () => {
    const v = revisarConteoCajon(HG1, 83981.89);
    expect(v).toEqual({ ok: true, suma: 83981.89, piezas: HG1.piezas, morralla: 0.39 });
  });

  it('[negativa] uno de menos lo dice con la cifra: faltan $1.00', () => {
    const v = revisarConteoCajon({ ...HG1, piezas: { ...HG1.piezas, '1': 0 } }, 83981.89);
    expect(v.ok).toBe(false);
    expect(v.ok ? '' : v.texto).toBe('El conteo suma $83,980.89 y del cajón salen $83,981.89: faltan $1.00.');
  });

  it('[negativa] de más también: sobran', () => {
    const v = revisarConteoCajon({ piezas: { '100': 2 }, morralla: 0 }, 150);
    expect(v.ok ? '' : v.texto).toContain('sobran $50.00');
  });

  it('[negativa] sin conteo no hay pago: nada suma $0.00', () => {
    expect(revisarConteoCajon(null, 10)).toMatchObject({ ok: false, motivo: 'no_cuadra' });
  });

  it('[negativa] una pieza fuera del catálogo, partida o negativa no es un conteo', () => {
    expect(revisarConteoCajon({ piezas: { '25': 1 }, morralla: 0 }, 25)).toMatchObject({ ok: false, motivo: 'pieza' });
    expect(revisarConteoCajon({ piezas: { '100': 1.5 }, morralla: 0 }, 150)).toMatchObject({ ok: false, motivo: 'pieza' });
    expect(revisarConteoCajon({ piezas: { '100': -1 }, morralla: 0 }, 0)).toMatchObject({ ok: false, motivo: 'pieza' });
  });

  it('[negativa] la morralla es de 0 a 49¢: 50¢ ya es una moneda', () => {
    expect(revisarConteoCajon({ piezas: {}, morralla: 0.5 }, 0.5)).toMatchObject({ ok: false, motivo: 'morralla' });
    expect(revisarConteoCajon({ piezas: {}, morralla: -0.1 }, 0)).toMatchObject({ ok: false, motivo: 'morralla' });
  });

  it('las piezas en cero no viajan; el texto va de la pieza mayor a la menor', () => {
    const v = revisarConteoCajon({ piezas: { '20': 0, '500': 1 }, morralla: 0 }, 500);
    expect(v.ok && v.piezas).toEqual({ '500': 1 });
    expect(textoConteoCajon({ piezas: { '20m': 1, '1000': 2 }, morralla: 0.2 })).toBe('2 × $1,000 · 1 × $20 (moneda) · morralla $0.20');
  });
});
