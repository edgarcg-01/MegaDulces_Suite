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

  it('sin la opción (levantamiento) no trae los de precio simbólico', () => {
    const sql = consultaBuscadorCatalogo(knex, '01', 'canels', 30).toString();
    expect(sql).not.toContain('k.c90 <= 0.05');
  });

  it('las dos ramas no se enciman: la vista exige > 0.05 y la rama nueva <= 0.05 y > 0', () => {
    expect(FUENTE_PRECIOS_COTIZACION).toMatch(/c90 > 0 AND k\.c90 <= 0\.05/);
  });
});

/**
 * `[COT.41]` El código escaneado se busca en las 7 casillas de Kepler, no sólo en el `barcode` de la
 * vista (`c7` o `c95`). ⚠️ Prueba de forma: el SQL se ejerció contra prod en sólo lectura el
 * 2026-11-11 (Canindo): el código de la 2ª casilla de la pieza (`c93`) del agua 59108 lo encuentra en
 * 160–180 ms; con `IN (SELECT …)` tardaba 1.0–1.2 s porque la vista se armaba entera.
 */
describe('[COT.41] código de barras en todas las casillas', () => {
  it('un término sin espacios se busca en las casillas de las tres unidades, de esa sucursal', () => {
    const sql = consultaBuscadorCatalogo(knex, '06', ' 7500533001091 ', 20, { incluirPrecioSimbolico: true }).toString();
    for (const c of ['c7', 'c93', 'c102', 'c82', 'c95', 'c96', 'c85']) expect(sql).toContain(`upper(btrim(k.${c}::text))`);
    expect(sql).toContain("k.sucursal = '06' AND '7500533001091' IN");
    expect(sql).toContain('v.sku = ANY(ARRAY(');
  });

  it('un término con espacios no es un código: no consulta las casillas', () => {
    const sql = consultaBuscadorCatalogo(knex, '06', 'agua members', 20, { incluirPrecioSimbolico: true }).toString();
    expect(sql).not.toContain('k.c93');
  });
});
