'use strict';
/**
 * `[VEC.6.2]` — **La caja se compara como ENTERO, que es como está indexada.**
 *
 * Tercer y último ajuste de la misma consulta. Medido en prod en cada paso, para el año en curso:
 *
 *     [VEC.4]   docs LEFT JOIN lineas, agregando por mes        6,959 ms
 *     [VEC.6]   LATERAL contra la vista de lineas               6,559 ms
 *     [VEC.6.1] LATERAL contra kdm2 directo                     1,565 ms
 *     [VEC.6.2] esta                                            ← ver abajo
 *
 * El índice que sirve a esa búsqueda es
 *
 *     ix_kdm2_venta_doc (btrim(sucursal), (c4)::integer, (c5)::integer, btrim(c6))
 *                 WHERE c2='U' AND c3='D'
 *
 * y el `LATERAL` preguntaba por `btrim((x.c5)::text) = d.caja`. **`(c5)::integer` y
 * `btrim((c5)::text)` son dos expresiones distintas**: la tercera columna del índice no se podía
 * usar, así que cada búsqueda traía todas las cajas de ese folio y descartaba después.
 *
 * ⚠️ `d.caja` es texto porque así se publica (es una etiqueta, no una cantidad). El `::integer`
 * va del lado de la comparación, no de la columna publicada.
 *
 * ⭐ Tres intentos para una consulta. Vale la pena el registro: en los tres el razonamiento era
 * correcto y en los dos primeros el efecto fue casi nulo, porque **el cuello estaba siempre un
 * piso más abajo de donde se estaba mirando**. Lo único que lo encontró fue medir después de
 * cada cambio, no antes.
 *
 * @param { import("knex").Knex } knex
 */

const DOCS = 'analytics.v_kepler_vecinal_sales_docs';
const MENSUAL = 'analytics.v_kepler_vecinal_monthly';

const DEF = `
SELECT
  d.tenant_id,
  d.warehouse_code,
  d.route_code,
  d.route_no,
  max(d.route_name)                             AS route_name,
  date_trunc('month', d.business_date)::date    AS month,
  sum(d.total)                                  AS revenue,
  COALESCE(sum(l.qty), 0)                       AS units,
  count(*)                                      AS tickets,
  sum(d.descuento)                              AS descuento,
  COALESCE(sum(l.importe), 0)                   AS revenue_lineas,
  count(*) FILTER (WHERE l.importe IS NOT NULL) AS docs_con_lineas,
  count(*) FILTER (WHERE l.importe IS NULL)     AS docs_sin_lineas,
  sum(d.total) - COALESCE(sum(l.importe), 0) + sum(d.descuento) AS importe_sin_lineas,
  max(d.business_date)                          AS last_sale_date
FROM ${DOCS} d
LEFT JOIN LATERAL (
  SELECT sum((x.c9)::numeric) AS qty, sum((x.c13)::numeric) AS importe
    FROM kepler_ods.kdm2 x
   WHERE btrim(x.sucursal) = d.warehouse_code
     AND btrim(x.c1)       = d.warehouse_code
     AND x.c2 = 'U'
     AND x.c3 = 'D'
     AND (x.c4)::integer = 10
     AND (x.c5)::integer = (d.caja)::integer
     AND btrim(x.c6) = d.folio
     AND btrim(COALESCE(x.c8, '')) <> ''
) l ON true
GROUP BY d.tenant_id, d.warehouse_code, d.route_code, d.route_no,
         date_trunc('month', d.business_date)::date`;

const COMENTARIO =
  '[VEC.6.2] Rollup mensual vecinal. revenue sale de la CABECERA (incluye los tickets cuyas '
  + 'lineas no llegaron al ODS y viene neto de descuento); units sale de las lineas y esta '
  + 'INCOMPLETA cuando docs_sin_lineas > 0 — no se estima, se declara. La caja se compara como '
  + 'entero porque asi la indexa ix_kdm2_venta_doc. Candado: test-newdb-vecinal-truth.js.';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${MENSUAL}`);
  await knex.raw(`CREATE VIEW ${MENSUAL} AS ${DEF}`);
  await knex.raw(`ALTER VIEW ${MENSUAL} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${MENSUAL} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${MENSUAL} IS ${lit(COMENTARIO)}`);
};

exports.down = async function down() {
  // Sin vuelta: las formas anteriores son la misma vista, medidas más lentas.
};
