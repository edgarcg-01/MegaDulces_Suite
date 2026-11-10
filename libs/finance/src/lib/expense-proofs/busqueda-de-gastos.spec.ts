import { leerBusqueda, sqlDelMonto, sqlFolioExactoPrimero } from './busqueda-de-gastos';

/**
 * `[GX.103]` Cómo se lee lo que alguien escribe en el buscador de gastos.
 *
 * Lo que vigila: que la caja vacía pida los recientes (como F9 en Kepler), que un monto se reconozca
 * como lo escribe la gente, y que la tolerancia sea para la FORMA y nunca para el significado.
 */
describe('[GX.103] leerBusqueda', () => {
  it('la caja vacía pide los recientes, como F9 en Kepler', () => {
    expect(leerBusqueda('')).toEqual({ modo: 'recientes' });
    expect(leerBusqueda('   ')).toEqual({ modo: 'recientes' });
    expect(leerBusqueda(undefined)).toEqual({ modo: 'recientes' });
  });

  it('una letra suelta es muy poco', () => {
    expect(leerBusqueda('a')).toEqual({ modo: 'corta' });
    expect(leerBusqueda('$')).toEqual({ modo: 'corta' });
  });

  it('un dígito sí busca: es un folio', () => {
    expect(leerBusqueda('7')).toEqual({ modo: 'buscar', texto: '7', monto: { valor: 7, alCentavo: false }, folio: 7 });
  });

  it('un número sin formato es folio Y monto al peso', () => {
    expect(leerBusqueda('10570')).toEqual({
      modo: 'buscar', texto: '10570', monto: { valor: 10570, alCentavo: false }, folio: 10570,
    });
  });

  it('⛔ con ceros adelante es un folio, nunca un monto', () => {
    expect(leerBusqueda('0010570')).toEqual({ modo: 'buscar', texto: '0010570', monto: null, folio: 10570 });
    expect(leerBusqueda('0')).toEqual({ modo: 'buscar', texto: '0', monto: null, folio: 0 });
  });

  it('el monto como lo escribe la gente: con pesos, comas y centavos', () => {
    const soloMonto = (valor: number, alCentavo: boolean) => ({ modo: 'buscar', texto: null, monto: { valor, alCentavo }, folio: null });
    expect(leerBusqueda('$1,250')).toEqual(soloMonto(1250, false));
    expect(leerBusqueda('1,250.00')).toEqual(soloMonto(1250, true));
    expect(leerBusqueda('$ 1,250.5')).toEqual(soloMonto(1250.5, true));
    expect(leerBusqueda('800.50')).toEqual(soloMonto(800.5, true));
    expect(leerBusqueda('$800')).toEqual(soloMonto(800, false));
    expect(leerBusqueda('1,234,567.89')).toEqual(soloMonto(1234567.89, true));
  });

  it('⛔ lo ambiguo NO se adivina como monto: se busca como texto', () => {
    // Tres decimales: ¿10 mil 570 con punto europeo o 10.57? No se adivina.
    expect(leerBusqueda('10.570')).toEqual({ modo: 'buscar', texto: '10.570', monto: null, folio: null });
    // Coma decimal: no es un grupo de tres.
    expect(leerBusqueda('1,25')).toEqual({ modo: 'buscar', texto: '1,25', monto: null, folio: null });
    // Un monto en cero no busca nada útil.
    expect(leerBusqueda('$0.00')).toEqual({ modo: 'buscar', texto: '$0.00', monto: null, folio: null });
  });

  it('el texto pasa tal cual (recortado) al motor', () => {
    expect(leerBusqueda('  papelería del centro ')).toEqual({ modo: 'buscar', texto: 'papelería del centro', monto: null, folio: null });
  });

  it('un número enorme no es folio ni monto (perdería precisión)', () => {
    const q = '1234567890123456';
    expect(leerBusqueda(q)).toEqual({ modo: 'buscar', texto: q, monto: null, folio: null });
  });

  it('corta a 80 caracteres', () => {
    const r = leerBusqueda('x'.repeat(200));
    expect(r.modo === 'buscar' && r.texto?.length).toBe(80);
  });
});

describe('[GX.103] sqlDelMonto', () => {
  it('al peso redondea; al centavo compara a dos decimales', () => {
    expect(sqlDelMonto('p.importe', { valor: 1250, alCentavo: false })).toBe('round(p.importe::numeric) = ?');
    expect(sqlDelMonto('r.importe', { valor: 1250.5, alCentavo: true })).toBe('round(r.importe::numeric, 2) = ?');
  });
});

describe('[GX.103] sqlFolioExactoPrimero', () => {
  it('compara sólo los dígitos del folio, como número, y deja los nulos al final', () => {
    expect(sqlFolioExactoPrimero('p.folio_solicitud'))
      .toBe("(NULLIF(regexp_replace(p.folio_solicitud, '[^0-9]', '', 'g'), '')::bigint = ?) DESC NULLS LAST");
  });

  it('⛔ no trae ningún ? de más: el único es el del folio (knex lo usaría como parámetro)', () => {
    expect(sqlFolioExactoPrimero('r.folio').split('?').length - 1).toBe(1);
  });
});
