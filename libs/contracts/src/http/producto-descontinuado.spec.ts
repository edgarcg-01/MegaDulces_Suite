import { PATRON_DESCONTINUADO_PG, esNombreDescontinuado, nombreSinMarcaDescontinuado } from './producto-descontinuado.contract';

describe('[PF.20] producto descontinuado (la marca vive en el nombre)', () => {
  it('reconoce las formas reales de Kepler y de nuestro catálogo', () => {
    for (const n of ['* DESCONTINUADO', '*DESCONTINUADO ', '* descontinuado', '***DESCONTINUADO PAL CHUPA CHUPS BOLSA CHOCO /40',
      '* DESCONTINUADO [57016]', 'GOMITA X *DESCONTINUADA']) {
      expect(esNombreDescontinuado(n)).toBe(true);
    }
  });

  it('[negativa] sin asterisco, vacío o nulo NO es descontinuado', () => {
    for (const n of ['PRODUCTO DESCONTINUADO POR PROVEEDOR', 'DESCONTINUADOS', 'OREO 9 KG', '', null, undefined]) {
      expect(esNombreDescontinuado(n)).toBe(false);
    }
    // «DESCONTINUADOR» no es la palabra.
    expect(esNombreDescontinuado('* DESCONTINUADOR')).toBe(false);
  });

  it('el nombre sin la marca: lo que quede, o vacío si Kepler no dejó otro nombre', () => {
    expect(nombreSinMarcaDescontinuado('* DESCONTINUADO')).toBe('');
    expect(nombreSinMarcaDescontinuado('*DESCONTINUADO ')).toBe('');
    expect(nombreSinMarcaDescontinuado('* DESCONTINUADO [57016]')).toBe('');
    expect(nombreSinMarcaDescontinuado('***DESCONTINUADO PAL CHUPA CHUPS BOLSA CHOCO /40')).toBe('PAL CHUPA CHUPS BOLSA CHOCO /40');
    expect(nombreSinMarcaDescontinuado('GOMITA X *DESCONTINUADA')).toBe('GOMITA X');
    // [negativa] un nombre normal no se toca (ni su «[SKU]»).
    expect(nombreSinMarcaDescontinuado('  OREO 9 KG [123] ')).toBe('OREO 9 KG [123]');
  });

  it('la versión de Postgres usa \\y como frontera (en Postgres \\b es el retroceso)', () => {
    expect(PATRON_DESCONTINUADO_PG).toContain('\\y');
    expect(PATRON_DESCONTINUADO_PG).not.toContain('\\b');
  });
});
