import { BadRequestException } from '@nestjs/common';
import { BUSQUEDA_MAXIMO, BUSQUEDA_OPCIONES, textoDeBusqueda } from './buscar-pedidos';

/** `[MCP.28]` `[MCP.30]` Lo que se acepta para buscar pedidos. */
describe('[MCP.28] textoDeBusqueda', () => {
  it('recorta y junta los espacios; respeta acentos y mayúsculas (el motor los normaliza)', () => {
    expect(textoDeBusqueda('  Lupita   payaso ')).toBe('Lupita payaso');
    expect(textoDeBusqueda('Dulcería')).toBe('Dulcería');
  });

  it('2 letras o números bastan («pd», un folio corto)', () => {
    expect(textoDeBusqueda('pd')).toBe('pd');
    expect(textoDeBusqueda('45')).toBe('45');
  });

  it('negativa: menos de 2 caracteres útiles (o nada, o sólo signos) es 400 con el porqué', () => {
    for (const malo of ['', ' ', 'a', '¿?', '- .', null, undefined, 123]) {
      expect(() => textoDeBusqueda(malo)).toThrow(BadRequestException);
    }
    expect(() => textoDeBusqueda('a')).toThrow('al menos 2');
  });

  it('se corta en el máximo (nadie escribe un párrafo en el buscador)', () => {
    expect(textoDeBusqueda('x'.repeat(BUSQUEDA_MAXIMO + 50))).toHaveLength(BUSQUEDA_MAXIMO);
  });

  it('el modo: estricto (sin «parecidos»), palabras cortas completas y el monto si es número', () => {
    expect(BUSQUEDA_OPCIONES).toMatchObject({ fuzzy: false, wholeWordUpTo: 2, numeric: ['o.total'] });
    expect(BUSQUEDA_OPCIONES.columns).toEqual(expect.arrayContaining(['o.code', 'c.name', 'lp.productos']));
  });
});
