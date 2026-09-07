/**
 * U.6b fix — `motivo` respondía DOS preguntas y la equivocada iba primero.
 *
 * ── El defecto, medido al aplicarla ────────────────────────────────────────────────────────
 * La primera versión ponía `erp_mixto_por_fecha` al frente de la precedencia, así que se comía
 * a las sucursales Kepler que tienen historia en los dos mundos: `01`, `02`, `04`, `05` y `06`
 * salieron marcadas "ERP mixto" con **$300.6M de venta (46.8%)**, cuando están perfectamente
 * cubiertas y su divisor de HOY es el de Kepler. La etiqueta era cierta como historia y
 * engañosa como estado.
 *
 * Es exactamente el mismo error de forma que el agujero del factor 1 en `v_unit_truth`: una
 * condición colocada demasiado arriba en el CASE se traga el caso común. Tercera vez en esta
 * fase que aparece, así que vale como patrón: **cuando un CASE mezcla dos preguntas, la
 * precedencia siempre le miente a una de las dos.** Se separan en dos columnas.
 *
 * ── El fix ─────────────────────────────────────────────────────────────────────────────────
 *   · `motivo` responde SÓLO "qué resuelve el divisor de este almacén" — kepler / wincaja /
 *     erp_mixto_por_fecha (cambió de ERP y NO tiene mapeo) / sin_mapeo_erp.
 *   · `cambio_de_erp` boolean, aparte, conserva el dato para quien lo necesite: el almacén tiene
 *     venta en un canal `wincaja_*` **y** en uno de Kepler. Vale para las 5 sucursales cubiertas
 *     (donde es historia) y para las 6 rutas de La Piedad (donde es el motivo de que no haya
 *     divisor estático posible).
 *   · `+ ult_wincaja` / `ult_kepler` para ver el cutover sin salir de la vista: en las rutas de
 *     La Piedad, Wincaja termina el 2026-06-26 y Kepler arranca el 2026-06-29, sin solape.
 *
 * Esperado después del fix: kepler 6 almacenes · wincaja 10 · erp_mixto_por_fecha 6 (las rutas
 * de La Piedad, ~$33.6M) y ninguna sucursal cubierta con etiqueta de mixta.
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
             count(*)::int                        AS celdas,
             count(*) FILTER (WHERE medible)::int  AS celdas_medibles
        FROM analytics.v_unit_truth
       GROUP BY 1, 2
    )
    SELECT w.tenant_id,
           w.id                                    AS warehouse_id,
           w.code                                  AS warehouse_code,
           w.name                                  AS warehouse_name,
           w.kind,
           w.kepler_code,
           w.wincaja_source_branch,
           COALESCE(v.venta_365d, 0)               AS venta_365d,
           v.ult_venta,
           v.ult_wincaja,
           v.ult_kepler,
           COALESCE(c.celdas, 0)                   AS celdas,
           COALESCE(c.celdas_medibles, 0)          AS celdas_medibles,
           (c.celdas IS NOT NULL AND c.celdas > 0) AS cubierto,

           -- Dato aparte, no mezclado con el motivo: el almacen vendio en los DOS mundos. En las
           -- sucursales cubiertas es historia (PH era Wincaja antes de julio); en las rutas de La
           -- Piedad es la razon de que no exista divisor estatico posible.
           (COALESCE(v.filas_wincaja, 0) > 0 AND COALESCE(v.filas_kepler, 0) > 0) AS cambio_de_erp,

           -- motivo responde UNA sola pregunta: que resuelve el divisor de este almacen.
           -- La cobertura va PRIMERO; el cambio de ERP solo importa cuando no hay mapeo.
           CASE
             WHEN w.kepler_code IS NOT NULL           THEN 'kepler'
             WHEN w.wincaja_source_branch IS NOT NULL THEN 'wincaja'
             WHEN COALESCE(v.filas_wincaja, 0) > 0
              AND COALESCE(v.filas_kepler, 0)  > 0    THEN 'erp_mixto_por_fecha'
             ELSE                                          'sin_mapeo_erp'
           END AS motivo
      FROM commercial.warehouses w
      LEFT JOIN vta v ON v.tenant_id = w.tenant_id AND v.warehouse_id = w.id
      LEFT JOIN cel c ON c.tenant_id = w.tenant_id AND c.warehouse_id = w.id
     WHERE w.deleted_at IS NULL
  `);

  await knex.raw('ALTER VIEW analytics.v_unit_truth_coverage SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_unit_truth_coverage TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth_coverage IS
    'U.6b - Declara que almacenes cubre analytics.v_unit_truth y cuales NO, con el motivo. Existe porque una fila AUSENTE se lee peor que una fila mala: en un LEFT JOIN llega NULL y un COALESCE(medible, true) la cuenta como medible (el candado de U.4 reportaba 98.2% por eso, agrupando solo por producto y sin ver el eje almacen). motivo responde UNA pregunta -- que resuelve el divisor -- con la cobertura primero; el cambio de ERP viaja aparte en cambio_de_erp, porque mezclarlos marcaba 5 sucursales Kepler cubiertas ($300.6M) como ERP mixto. motivo = erp_mixto_por_fecha son las 6 rutas de La Piedad: Wincaja hasta 2026-06-26 y Kepler desde 2026-06-29, sin solape, asi que ninguna columna estatica puede darles un divisor. Se detecta por dato, no por lista escrita a mano.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth_coverage');
};
