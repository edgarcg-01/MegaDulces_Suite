/**
 * U.6b — `analytics.v_unit_truth_coverage`: qué almacenes cubre el resolvedor y qué NO.
 *
 * ── Por qué hace falta una vista para esto ─────────────────────────────────────────────────
 * `v_unit_truth` sólo tiene filas para almacenes con `kepler_code` o `wincaja_source_branch`. Un
 * almacén sin mapeo no sale mal: **no sale**. Y una fila ausente es peor que una fila mala,
 * porque en un LEFT JOIN llega como NULL y cualquier `COALESCE(medible, true)` la cuenta como
 * medible. Mi propio candado cayó en eso: reportaba 98.2% de cobertura porque agrupaba por
 * producto y no veía el eje almacén, donde faltaba el 9.4% de la venta.
 *
 * Regla del proyecto: lo que falta se DECLARA, no se disfraza de default. Esta vista es la
 * declaración, y sirve de banner en pantalla y de aserción en el test.
 *
 * ── Los tres motivos, y por qué son distintos ──────────────────────────────────────────────
 *   · `kepler` / `wincaja`  — cubierto: hay divisor y tiene veredicto.
 *   · `erp_mixto_por_fecha` — ⚠️ el almacén CAMBIÓ de ERP y su divisor depende de la FECHA, así
 *     que una columna estática no puede expresarlo. Son las 6 rutas de La Piedad (RUTA-21, 22,
 *     23, 26, 27, 28): Wincaja hasta el 2026-06-26, Kepler desde el 2026-06-29 (Kepler emite
 *     '01-00N' y el importer traduce a RUTA-2N). Medido, sin solape. Se DETECTA por dato — el
 *     almacén tiene venta en un canal `wincaja_*` Y en uno de Kepler — no por lista escrita.
 *   · `sin_mapeo_erp`       — no tiene ni `kepler_code` ni `wincaja_source_branch` y nadie sabe
 *     de dónde sale su unidad. Hay que investigarlo, no rellenarlo.
 *
 * Medido en prod 2026-09-07, después de mapear las 7 rutas Wincaja-puras (mig 20260907130000):
 * quedan las 6 de La Piedad como `erp_mixto_por_fecha`, con ~$26.5M de venta 365d.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth_coverage');

  await knex.raw(`
    CREATE VIEW analytics.v_unit_truth_coverage AS
    WITH vta AS (
      SELECT s.tenant_id, s.warehouse_id,
             sum(s.revenue)::numeric                                       AS venta_365d,
             count(*) FILTER (WHERE s.channel LIKE 'wincaja%')::int        AS filas_wincaja,
             count(*) FILTER (WHERE s.channel NOT LIKE 'wincaja%')::int    AS filas_kepler,
             max(s.sale_date) FILTER (WHERE s.channel LIKE 'wincaja%')     AS ult_wincaja,
             max(s.sale_date) FILTER (WHERE s.channel NOT LIKE 'wincaja%') AS ult_kepler,
             max(s.sale_date)                                              AS ult_venta
        FROM analytics.sales_daily s
       WHERE s.sale_date >= current_date - 365
       GROUP BY 1, 2
    ), cel AS (
      SELECT tenant_id, warehouse_id,
             count(*)::int                            AS celdas,
             count(*) FILTER (WHERE medible)::int     AS celdas_medibles
        FROM analytics.v_unit_truth
       GROUP BY 1, 2
    )
    SELECT w.tenant_id,
           w.id                                   AS warehouse_id,
           w.code                                 AS warehouse_code,
           w.name                                 AS warehouse_name,
           w.kind,
           w.kepler_code,
           w.wincaja_source_branch,
           COALESCE(v.venta_365d, 0)              AS venta_365d,
           v.ult_venta,
           COALESCE(c.celdas, 0)                  AS celdas,
           COALESCE(c.celdas_medibles, 0)         AS celdas_medibles,
           (c.celdas IS NOT NULL AND c.celdas > 0) AS cubierto,
           CASE
             -- El cambio de ERP se DETECTA por dato: venta en los dos mundos. No hay lista escrita
             -- a mano, asi que el dia que otro almacen migre, aparece solo.
             WHEN v.filas_wincaja > 0 AND v.filas_kepler > 0 THEN 'erp_mixto_por_fecha'
             WHEN w.kepler_code IS NOT NULL                  THEN 'kepler'
             WHEN w.wincaja_source_branch IS NOT NULL        THEN 'wincaja'
             ELSE                                                 'sin_mapeo_erp'
           END AS motivo
      FROM commercial.warehouses w
      LEFT JOIN vta v ON v.tenant_id = w.tenant_id AND v.warehouse_id = w.id
      LEFT JOIN cel c ON c.tenant_id = w.tenant_id AND c.warehouse_id = w.id
     WHERE w.deleted_at IS NULL
  `);

  await knex.raw('ALTER VIEW analytics.v_unit_truth_coverage SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_unit_truth_coverage TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth_coverage IS
    'U.6b - Declara que almacenes cubre analytics.v_unit_truth y cuales NO, con el motivo. Existe porque una fila AUSENTE se lee peor que una fila mala: en un LEFT JOIN llega NULL y un COALESCE(medible, true) la cuenta como medible (el candado de U.4 reportaba 98.2% de cobertura por eso, agrupando solo por producto). motivo = erp_mixto_por_fecha marca los almacenes que CAMBIARON de ERP y cuyo divisor depende de la fecha: las 6 rutas de La Piedad, Wincaja hasta 2026-06-26 y Kepler desde 2026-06-29. Se detecta por dato (venta en canal wincaja_* Y en canal Kepler), no por lista escrita a mano.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth_coverage');
};
