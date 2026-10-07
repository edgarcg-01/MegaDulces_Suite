import knexFactory from 'knex';
// Import directo del archivo (no del índice de platform-core): el índice hace fail-fast de
// secretos al importarse y esta prueba sólo necesita la función pura.
import { applySmartSearch, stemVariants } from '../../../../platform-core/src/lib/search/smart-search';
import { PALABRAS_RELLENO, SINONIMOS_CATALOGO } from './catalog-search-terms';

/**
 * COT.16 — el buscador de artículos tiene que entender el DICTADO telefónico. Cada caso salió de
 * una búsqueda real que dio cero resultados en la simulación de 3 pedidos de 15 partidas.
 */
const knex = knexFactory({ client: 'pg' });

function sqlDe(q: string) {
  const qb = knex('analytics.v_label_prices as v').select('v.sku');
  applySmartSearch(qb, q, {
    columns: ['v.name', 'v.sku'],
    fuzzy: false,
    stem: true,
    synonyms: SINONIMOS_CATALOGO,
    ignore: PALABRAS_RELLENO,
  });
  return qb.toSQL().toNative();
}

describe('stemVariants (singular y sin diminutivo)', () => {
  it('"pistaches" también busca "pistach" (el catálogo dice PISTACHOS)', () => {
    expect(stemVariants('pistaches')).toContain('pistach');
  });
  it('"payasitos" también busca "payaso"', () => {
    expect(stemVariants('payasitos')).toContain('payaso');
  });
  it('"paletas" también busca "paleta"', () => {
    expect(stemVariants('paletas')).toContain('paleta');
  });
  it('no toca palabras cortas ni con dígitos', () => {
    expect(stemVariants('mas')).toEqual([]);
    expect(stemVariants('25x35')).toEqual([]);
  });
});

describe('applySmartSearch con el vocabulario de cotizaciones', () => {
  it('"paleta jumbo" acepta PAL como palabra completa (no PALOMITAS)', () => {
    const { bindings } = sqlDe('paleta jumbo');
    expect(bindings).toContain('(\\m|[0-9])pal\\M');
    expect(bindings).toContain('%jumbo%');
  });

  it('"chocolates" llega a CHOC por su singular', () => {
    const { bindings } = sqlDe('chocolates ranita');
    expect(bindings).toContain('%chocolate%');
    expect(bindings).toContain('(\\m|[0-9])choc\\M');
  });

  it('"altos 25 por 35" no exige la palabra "por"', () => {
    const { bindings } = sqlDe('altos 25 por 35');
    expect(bindings).not.toContain('%por%');
    expect(bindings).toEqual(expect.arrayContaining(['%altos%', '%25%', '%35%']));
  });

  it('"canels bolsa de kilo" pega con "1KG" (sinónimo pegado al número)', () => {
    const { bindings } = sqlDe('canels bolsa de kilo');
    expect(bindings).toContain('(\\m|[0-9])kg\\M');
    expect(bindings).not.toContain('%de%');
  });

  it('si TODO es relleno, no se convierte en "traer todo"', () => {
    const { bindings } = sqlDe('de la');
    expect(bindings).toEqual(expect.arrayContaining(['%de%', '%la%']));
  });

  it('sin la opción `stem`, el comportamiento de siempre no cambia', () => {
    const qb = knex('t').select('a');
    applySmartSearch(qb, 'paletas', { columns: ['name'], fuzzy: false });
    expect(qb.toSQL().toNative().bindings).toEqual(['%paletas%']);
  });
});
