import knexFactory from 'knex';
// El índice de platform-core hace fail-fast de secretos al importarse: se sirve la función pura.
vi.mock('@megadulces/platform-core', async () => import('../../../../platform-core/src/lib/search/smart-search'));
import { consultaBuscadorCatalogo, FUENTE_PRECIOS_COTIZACION } from './catalogo-buscador';

/**
 * `[COT.27]` El cotizador encuentra los regalos de promoción de $0.01 (09003 «5 EXH CANELS = GRATIS
 * 1 EXH MAS»), que `v_label_prices` excluye a propósito; el levantamiento (NP.7.L.10) sigue igual.
 * ⚠️ Prueba de forma: el SQL de la fuente se ejerció a mano contra prod (sólo lectura, 2026-11-05):
 * 9,520 filas en la 01 = 9,301 de la vista + 219 de precio simbólico, 09003 a $0.01.
 */
const knex = knexFactory({ client: 'pg' });

describe('[COT.27] fuente de precios con precio simbólico', () => {
  it('el cotizador lee la vista MÁS los artículos de kdii de hasta 5 centavos', () => {
    const sql = consultaBuscadorCatalogo(knex, '01', 'canels', 30, { incluirPrecioSimbolico: true }).toString();
    expect(sql).toContain('analytics.v_label_prices');
    expect(sql).toContain('kepler_ods.kdii');
    expect(sql).toContain('k.c90 <= 0.05');
  });

  it('sin la opción (levantamiento) no cambia: sólo la vista', () => {
    const sql = consultaBuscadorCatalogo(knex, '01', 'canels', 30).toString();
    expect(sql).not.toContain('kepler_ods.kdii');
  });

  it('las dos ramas no se enciman: la vista exige > 0.05 y la rama nueva <= 0.05 y > 0', () => {
    expect(FUENTE_PRECIOS_COTIZACION).toMatch(/c90 > 0 AND k\.c90 <= 0\.05/);
  });
});
