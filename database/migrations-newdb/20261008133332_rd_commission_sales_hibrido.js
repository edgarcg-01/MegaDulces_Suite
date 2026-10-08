'use strict';
/**
 * `[RD.54]` — **El insumo de la comisión deja de re-derivar lo que ya está materializado.**
 *
 * ── Lo medido antes, contra prod el 2026-10-08 ──────────────────────────────────────────────
 *
 *   Q20 (dentro de la matvista)   vista viva 1,096 ms  →  híbrido    20 ms   **55x**
 *   Q6  (a caballo del límite)    vista viva 3,386 ms  →  híbrido 2,884 ms
 *   Q1  (fuera de la matvista)    idénticas
 *
 * Y las tres dan **exactamente el mismo resultado**: Q20 `3,016,298.68 / 201 filas`,
 * Q6 `2,594,443.37 / 156 filas` (117 de ellas antes del límite), Q1 `2,621,635.30 / 143`.
 *
 * `analytics.mv_rd_route_daily_200d` existe desde antes, se refresca **cada 30 min** y ya la
 * consumen Ventas por ruta y `me-zona`. El motor de comisiones era el único que leía la vista
 * VIVA, y por eso contrastar un año costaba **cuatro minutos**: 21 de las 27 quincenas caen
 * enteras dentro de la matvista.
 *
 * ── ⛔ Las dos trampas, y por qué el híbrido va por FILA y no por periodo ────────────────────
 *
 * **1. Hay una quincena A CABALLO.** La matvista cubre `2026-03-23 → 2026-12-06`: 21 periodos
 * caen dentro, 5 fuera y **la Q6 (12-25 mar) cruza el límite**. Un híbrido que eligiera fuente
 * *por periodo* le daría a esa quincena una venta incompleta o duplicada. El corte va por
 * `business_date`, fila por fila, y por eso no hay ni hueco ni traslape.
 *
 * **2. ⛔⛔ Con la matvista VACÍA, el híbrido ingenuo devuelve CERO FILAS.** Medido:
 *
 *     sin guarda  →   0 filas      business_date < NULL  es NULL: la rama viva no aporta nada
 *     con guarda  → 201 filas      = exactamente lo que da la vista viva sola
 *
 * O sea que una matvista vacía —o un refresco que falle y la deje así— haría que el motor
 * calculara **venta cero para todos, en silencio**, y una corrida de nómina saldría en ceros
 * sin un solo error. Por eso el límite va envuelto en `COALESCE(..., 'infinity')`: sin
 * matvista, la rama viva cubre TODO y el resultado es el de antes, sólo que lento.
 *
 * ⚠️ No se toca `analytics.v_rd_route_daily`: sigue siendo la fuente de verdad y la leen otros.
 * Lo que cambia es de dónde lee `v_rd_commission_sales`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const RAPIDO = 'analytics.v_rd_route_daily_rapido';
const SALES = 'analytics.v_rd_commission_sales';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW ${RAPIDO} AS
    SELECT * FROM analytics.mv_rd_route_daily_200d
    UNION ALL
    SELECT * FROM analytics.v_rd_route_daily
     WHERE business_date < COALESCE(
       (SELECT min(business_date) FROM analytics.mv_rd_route_daily_200d),
       'infinity'::date)`);

  await knex.raw(`ALTER VIEW ${RAPIDO} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${RAPIDO} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${RAPIDO} IS
    'RD.54 - el dia-ruta leyendo la matvista donde la hay y la vista viva donde no. El corte va por business_date FILA POR FILA, no por periodo: la quincena 6 cruza el limite de la matvista y elegir fuente por periodo le daria venta incompleta o duplicada. El COALESCE a infinity NO es decorativo: sin el, una matvista vacia devuelve CERO filas (business_date < NULL es NULL) y el motor calcularia venta cero para todos en silencio. Medido: Q20 1,096 ms -> 20 ms, con resultado identico.'`);

  // `v_rd_commission_sales` pasa a leer el híbrido. Mismo SELECT, misma salida, otra fuente.
  await knex.raw(`
    CREATE OR REPLACE VIEW ${SALES} AS
    SELECT tenant_id,
           route_code,
           business_date,
           sum(subtotal) AS subtotal,
           sum(venta)    AS venta,
           sum(subtotal) FILTER (WHERE source = 'push')           AS subtotal_push,
           sum(subtotal) FILTER (WHERE source = 'wincaja')        AS subtotal_wincaja,
           sum(subtotal) FILTER (WHERE source = 'kepler_vecinal') AS subtotal_vecinal,
           sum(costo)    FILTER (WHERE source = 'wincaja')        AS costo_wincaja,
           count(DISTINCT source)::integer                        AS fuentes,
           string_agg(DISTINCT source, '+' ORDER BY source)       AS fuentes_dia,
           count(DISTINCT source) > 1                             AS dia_multifuente,
           sum(tickets)::integer                                  AS tickets
      FROM ${RAPIDO} d
     GROUP BY tenant_id, route_code, business_date`);

  await knex.raw(`ALTER VIEW ${SALES} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${SALES} TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: `v_rd_commission_sales` vuelve a la vista viva. */
exports.down = async function down(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${SALES} AS
    SELECT tenant_id, route_code, business_date,
           sum(subtotal) AS subtotal, sum(venta) AS venta,
           sum(subtotal) FILTER (WHERE source = 'push')           AS subtotal_push,
           sum(subtotal) FILTER (WHERE source = 'wincaja')        AS subtotal_wincaja,
           sum(subtotal) FILTER (WHERE source = 'kepler_vecinal') AS subtotal_vecinal,
           sum(costo)    FILTER (WHERE source = 'wincaja')        AS costo_wincaja,
           count(DISTINCT source)::integer                        AS fuentes,
           string_agg(DISTINCT source, '+' ORDER BY source)       AS fuentes_dia,
           count(DISTINCT source) > 1                             AS dia_multifuente,
           sum(tickets)::integer                                  AS tickets
      FROM analytics.v_rd_route_daily d
     GROUP BY tenant_id, route_code, business_date`);
  await knex.raw(`ALTER VIEW ${SALES} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${SALES} TO app_runtime`);
  await knex.raw(`DROP VIEW IF EXISTS ${RAPIDO}`);
};
