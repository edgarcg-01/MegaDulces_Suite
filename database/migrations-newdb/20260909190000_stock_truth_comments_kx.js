/**
 * KX — los COMMENT de las dos vistas de existencia decían algo que la medición REFUTÓ.
 *
 * `v_kepler_unit_cost` se comentó en prod como *"con el anti-replica aplicado"*. Al buscar el
 * patrón en lo INCORRECTO (pedido de Edgar, 2026-09-09) esa etiqueta no se sostuvo: las 3,667
 * filas que el filtro `sucursal = c1` descarta son TODAS de la sucursal 03 y casi todas del
 * almacén `02`, y contra suc02/alm02 sólo el **3.66%** tiene entradas acumuladas idénticas —
 * **1,049 SKUs van por DELANTE** (una réplica no adelanta al original) y **645 sólo existen en la
 * 03**. En `kdil` son **90,630 unidades de existencia** que no publicamos, de naturaleza **no
 * establecida**.
 *
 * Y de paso queda escrito en la DB lo que el árbitro ES: `c16 = c8/c5` con `c5` == entradas
 * acumuladas de `kdil.c8` en **25,143 de 25,143 pares (100.00%)**, o sea **costo promedio
 * ponderado histórico**, no costo de reposición (mediana `c16/c18` = 0.9805).
 *
 * Sólo cambia metadata: ni una línea de SQL de las vistas se toca, así que no hay efecto en
 * ninguna cifra publicada. Un comentario que miente es documentación que cobra después.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const has = async (v) => (await knex.raw(
    `SELECT to_regclass('analytics.${v}') t`)).rows[0].t;

  if (await has('v_kepler_unit_cost')) {
    await knex.raw(`COMMENT ON VIEW analytics.v_kepler_unit_cost IS
      'KE.2/KX: costo PROMEDIO PONDERADO HISTORICO de Kepler (kdik.c16 = c8/c5, con c5 = entradas acumuladas) por almacen x producto. UNICA implementacion: la leen v_erp_stock_truth y la pantalla de existencia. El filtro sucursal=c1 descarta 3,667 filas (suc 03 / almacen 02, 90,630 u en kdil) cuya naturaleza NO esta establecida: se declara como hueco en docs/VERDAD_ABSOLUTA.md seccion 7, no se afirma que sea replica.'`);
  }

  if (await has('v_erp_stock_truth')) {
    await knex.raw(`COMMENT ON VIEW analytics.v_erp_stock_truth IS
      'Existencia de Kepler con su propio costo por sucursal x SKU (kdik.c16, promedio historico) como testigo. Devuelve los DOS costos y el veredicto; no elige. valor_arbitrado es NULL sin testigo. La cantidad trae 1,818 saldos negativos recortados a cero (-68,504 u) que se DECLARAN, no se explican: docs/VERDAD_ABSOLUTA.md seccion 3.1b.'`);
  }
};

exports.down = async function down() {
  // Los comentarios previos afirmaban algo refutado. No se restauran a proposito.
};
