'use strict';
/**
 * `[VEC.6]` — **El rollup mensual se arma con `LATERAL` para que el filtro de fecha llegue a las
 * dos piernas.**
 *
 * `[VEC.4]` dejó el mensual como `docs LEFT JOIN lineas` agregando cada pierna por mes. Es
 * correcto y es lento: medido en prod, **6,959 ms** para el año en curso, contra un gate de 1 s.
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────────────────────
 *
 * El consumidor filtra por `month`. Ese predicado se puede empujar a la pierna de documentos
 * —`month` sale de su `GROUP BY`— pero **no al lado nullable de un `LEFT JOIN`**: hacerlo
 * cambiaría el resultado, así que el planner no lo intenta. Resultado: para pintar un año,
 * la pierna de líneas agregaba **toda la historia** y después se descartaba casi todo.
 *
 * El índice `[VEC.5]` ya había arreglado la pierna barata (la cabecera pasó de 1,506 a **54 ms**)
 * y aun así el rollup seguía en siete segundos: *el cuello no estaba donde se había medido*.
 *
 * ── El arreglo ──────────────────────────────────────────────────────────────────────────────
 *
 * Con `LEFT JOIN LATERAL`, la pierna de líneas **depende** de cada documento, así que sólo se
 * ejecuta para los documentos que sobrevivieron al filtro. El predicado de fecha deja de tener
 * que "atravesar" nada: se aplica donde entra el dato.
 *
 * Son ~8,200 búsquedas puntuales sobre `kdm2` por `ix_kdm2_venta_doc` (≈0.02 ms cada una) en vez
 * de un barrido de 4.9 millones de líneas.
 *
 * ⚠️ Las columnas y su significado **no cambian** respecto de `[VEC.4]`: `revenue` sigue saliendo
 * de la cabecera, `units` de las líneas, y el hueco de la fuente se sigue declarando en
 * `docs_sin_lineas` / `importe_sin_lineas`. Esto es sólo la forma de calcularlo.
 *
 * @param { import("knex").Knex } knex
 */

const DOCS = 'analytics.v_kepler_vecinal_sales_docs';
const LINEAS = 'analytics.v_kepler_vecinal_sales_lines';
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
  SELECT sum(x.qty) AS qty, sum(x.importe) AS importe
    FROM ${LINEAS} x
   WHERE x.tenant_id      = d.tenant_id
     AND x.warehouse_code = d.warehouse_code
     AND x.business_date  = d.business_date
     AND x.caja           = d.caja
     AND x.folio          = d.folio
) l ON true
GROUP BY d.tenant_id, d.warehouse_code, d.route_code, d.route_no,
         date_trunc('month', d.business_date)::date`;

const COMENTARIO =
  '[VEC.6] Rollup mensual vecinal. revenue sale de la CABECERA (incluye los tickets cuyas lineas '
  + 'no llegaron al ODS y viene neto de descuento); units sale de las lineas y esta INCOMPLETA '
  + 'cuando docs_sin_lineas > 0 — no se estima, se declara. El LATERAL es por rendimiento: con '
  + 'LEFT JOIN el filtro de fecha no alcanzaba la pierna de lineas y el ano en curso costaba '
  + '6,959 ms. Candado: test-newdb-vecinal-truth.js.';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${MENSUAL}`);
  await knex.raw(`CREATE VIEW ${MENSUAL} AS ${DEF}`);
  await knex.raw(`ALTER VIEW ${MENSUAL} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${MENSUAL} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${MENSUAL} IS ${lit(COMENTARIO)}`);
};

exports.down = async function down() {
  // Sin vuelta: la forma anterior es la misma vista, más lenta. Si hiciera falta, se reaplica
  // `20261006250000`.
};
