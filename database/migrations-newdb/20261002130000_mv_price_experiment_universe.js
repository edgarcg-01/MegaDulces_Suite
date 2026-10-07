'use strict';
/**
 * [PR.D5] -- Disenar un experimento tardaba 1 minuto 45 segundos. Medido, no estimado.
 *
 * -- Lo que se midio contra prod ---------------------------------------------------------------
 * El disenador corre la MISMA consulta una vez por estrato, y son cuatro:
 *
 *   estrato $1-$10       8,306 ms
 *   estrato $10-$50     53,219 ms
 *   estrato $50-$100    29,077 ms
 *   estrato > $100      14,309 ms
 *   ------------------------------
 *   total              104,911 ms   -- y eso es SOLO la lectura, sin contar los INSERT
 *
 * -- ⛔⛔ Y la causa es contraintuitiva: FILTRAR la vista la hace mas lenta -----------------------
 *
 *   analytics.v_price_psychology, entera y sin filtros .............    210 ms  (86,233 filas)
 *   la misma, con los filtros del disenador y ORDER BY .............. 59,149 ms  ( 9,352 filas)
 *
 * 280 veces mas lenta para devolver nueve veces menos filas. Es el planificador empujando los
 * predicados DENTRO de la vista, que cuelga de analytics.v_kepler_standard_cost y de ahi del ODS:
 * con un filtro selectivo adentro, el plan deja de agregar en bloque.
 *
 * ⭐ Sacar los filtros del CTE y ponerlos AFUERA, con el universo materializado, baja el total a
 *   2,380 ms. Es 44x, es gratis y no cambia ninguna cifra -- pero sigue muy por encima del medio
 *   segundo que la pantalla necesita, y el piso de esa arquitectura son ~2 s.
 *
 * -- Por que una MATVISTA, y por que se puede ---------------------------------------------------
 * Se materializa por COSTO, que es el caso legitimo (GOTCHAS §19): es una COPIA de la vista, no
 * una segunda definicion. Las columnas se eligen: medido, pedirle `SELECT *` a esa vista cuesta
 * 10,031 ms contra 785 ms si se piden solo las que el disenador usa.
 *
 * ⚠️ La objecion obvia es la frescura: el experimento registra `precio_antes`, y una matvista
 *    nocturna lo tendria con hasta 24 h de atraso. **No aplica, y por construccion**: el propio
 *    disenador EXCLUYE las celdas cuyo precio cambio tres o mas veces en siete dias. Lo que
 *    sobrevive al filtro es, por definicion, precio estable. El candado lo comprueba en vez de
 *    confiar en el argumento.
 *
 * ⭐ `oscila` entra como COLUMNA de la matvista y deja de ser un CTE: hoy ese CTE agrega 806,141
 *   filas de analytics.master_data_history (los cambios de precio de 7 dias) y cuesta 606 ms, y
 *   se recalcula una vez por estrato.
 *
 * ⚠️ Hallazgo aparte, que no es de esta fase pero sale de medirla: 806,141 cambios de precio en
 *    siete dias sobre 9,616 filas de commercial.product_prices son **84 reescrituras por precio
 *    por semana**. Eso no son decisiones de precio: es churn de un importer que reescribe la fila
 *    aunque no cambie. Queda declarado.
 */

const MV = 'analytics.mv_price_experiment_universe';
// ⚠️ 20, el MISMO numero que price-experiment.service.ts. Medir con otro valor y codificar
//    este habria cambiado a quien se considera precio inestable sin que nada fallara.
const OSCILA_CAMBIOS_7D = 20;

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MV} AS
    WITH oscilan AS (
      SELECT cp.sku
        FROM analytics.master_data_history h
        JOIN commercial.product_prices pp ON pp.id::text = h.pk::text
        JOIN catalog.products cp ON cp.id = pp.product_id
       WHERE h.tabla = 'commercial.product_prices'
         AND h.changed_at >= CURRENT_DATE - 7
       GROUP BY cp.sku
      HAVING count(*) >= ${OSCILA_CAMBIOS_7D})
    SELECT
      p.sucursal, p.sku, p.nombre, p.precio,
      p.cand_00, p.cand_50, p.cand_90, p.cand_99,
      p.venta_neta_30d, p.terminacion, p.veredicto,
      -- El candado del precio inestable, ya resuelto: deja de ser un CTE que se recalcula
      -- cuatro veces y pasa a ser una columna.
      (o.sku IS NOT NULL) AS oscila,
      now() AS calculado_al
    FROM analytics.v_price_psychology p
    LEFT JOIN oscilan o ON o.sku = p.sku
    WITH NO DATA`);

  // ⭐ UNIQUE es requisito de REFRESH CONCURRENTLY: sin el, el refresco toma un lock exclusivo y
  //   el disenador se queda esperando justo cuando alguien esta armando un experimento.
  await knex.raw(`CREATE UNIQUE INDEX mv_pxu_pk ON ${MV} (sucursal, sku)`);
  // El indice del camino caliente: el disenador filtra por estos tres y ordena por venta.
  await knex.raw(`CREATE INDEX mv_pxu_elegible ON ${MV} (terminacion, veredicto, precio)
                  WHERE NOT oscila AND venta_neta_30d > 0`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    'Copia cacheada del universo elegible para experimentos de precio. Se materializa por COSTO: medido contra prod, el disenador tardaba 104,911 ms porque corre la misma lectura una vez por estrato y porque FILTRAR analytics.v_price_psychology la vuelve 280x mas lenta (210 ms entera, 59,149 ms con filtros). Es una COPIA de la vista, no una segunda definicion. La frescura nocturna no afecta a precio_antes porque el disenador ya excluye las celdas con precio inestable. Umbral en CRON_JOBS: analytics_refresh_price_experiment_universe. [PR.D5]'`);

  // eslint-disable-next-line no-console
  console.log('[PR.D5] mv_price_experiment_universe creada WITH NO DATA · '
    + 'el primer REFRESH lo hace el nocturno (o AnalyticsRefreshService al arrancar).');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
