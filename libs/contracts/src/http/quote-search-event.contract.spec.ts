import { LARGO_TERMINO_BUSQUEDA, normalizarTerminoBusqueda } from './quote-search-event.contract';

describe('[COT.53] el término del buscador, como se cuenta', () => {
  it('«Mazapan » y «mazapan» suman en el mismo renglón; los acentos se quedan', () => {
    expect(normalizarTerminoBusqueda('  Mazapan  ')).toBe('mazapan');
    expect(normalizarTerminoBusqueda('MAZAPÁN   de  la rosa')).toBe('mazapán de la rosa');
  });

  it('vacío o nulo no es término', () => {
    expect(normalizarTerminoBusqueda('   ')).toBe('');
    expect(normalizarTerminoBusqueda(null)).toBe('');
  });

  it('se recorta a su tope', () => {
    expect(normalizarTerminoBusqueda('x'.repeat(200))).toHaveLength(LARGO_TERMINO_BUSQUEDA);
  });
});
