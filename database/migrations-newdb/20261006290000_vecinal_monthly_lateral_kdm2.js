'use strict';
/**
 * `[VEC.6.1]` — **El `LATERAL` apunta a `kdm2`, no a la vista de líneas.**
 *
 * `[VEC.6]` (`20261006280000`) pasó el rollup a `LEFT JOIN LATERAL` para que el filtro de fecha
 * llegara a las dos piernas. La forma era la correcta y **no sirvió de nada**: medido en prod,
 * 6,959 ms antes y **6,559 ms** después.
 *
 * ── Lo que faltaba ver ──────────────────────────────────────────────────────────────────────
 *
 * El `LATERAL` leía `analytics.v_kepler_vecinal_sales_lines`, y esa vista **vuelve a unir
 * `kdm1` con `kdm2`** para decidir qué líneas son vecinales. Pero dentro del `LATERAL` la
 * cabecera ya está resuelta: es `d`. O sea que por cada uno de los ~8,200 documentos se repetía
 * un join que ya estaba hecho.
 *
 * Leyendo `kdm2` directo, con la llave del documento que `d` ya trae (plaza, caja, folio), cada
 * iteración es una búsqueda puntual por `ix_kdm2_venta_doc`.
 *
 * ⭐ La lección, que es la misma de `[VEC.5]`: **el cuello se mide, no se deduce.** Dos arreglos
 * razonables seguidos —un índice y un `LATERAL`— y el tiempo casi no se movió, porque el costo
 * estaba un piso más abajo de donde se estaba mirando cada vez.
 *
 * ⚠️ El universo de la vista de líneas se preserva en el `LATERAL` (`c8` no vacío = renglón con
 * producto), para que `revenue_lineas` siga siendo comparable con ella y el candado pueda cruzar
 * las dos derivaciones.
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
     AND btrim((x.c5)::text) = d.caja
     AND btrim(x.c6) = d.folio
     AND btrim(COALESCE(x.c8, '')) <> ''
) l ON true
GROUP BY d.tenant_id, d.warehouse_code, d.route_code, d.route_no,
         date_trunc('month', d.business_date)::date`;

const COMENTARIO =
  '[VEC.6.1] Rollup mensual vecinal. revenue sale de la CABECERA (incluye los tickets cuyas '
  + 'lineas no llegaron al ODS y viene neto de descuento); units sale de las lineas y esta '
  + 'INCOMPLETA cuando docs_sin_lineas > 0 — no se estima, se declara. El LATERAL lee kdm2 '
  + 'DIRECTO: contra la vista de lineas se rehacia el join con la cabecera 8,200 veces y el ano '
  + 'en curso costaba 6,559 ms. Candado: test-newdb-vecinal-truth.js.';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${MENSUAL}`);
  await knex.raw(`CREATE VIEW ${MENSUAL} AS ${DEF}`);
  await knex.raw(`ALTER VIEW ${MENSUAL} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${MENSUAL} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${MENSUAL} IS ${lit(COMENTARIO)}`);
};

exports.down = async function down() {
  // Sin vuelta: la forma anterior es la misma vista, medida más lenta.
};
