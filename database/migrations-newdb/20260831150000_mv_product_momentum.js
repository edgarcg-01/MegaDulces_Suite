/**
 * PERF — `ThotService.suggest()` (recomendaciones) computaba la señal de MOMENTUM en
 * vivo dentro de su query de scoring: una CTE `mom` que agrega 90 días de
 * `analytics.sales_daily` (301k filas) por producto con doble `SUM(...) FILTER` →
 * ~1.4 s POR request. Y `suggest()` es interactivo: lo llaman el endpoint de
 * recomendaciones y 3 herramientas del chat de Thot (portal/vendedor/admin).
 *
 * El momentum es `r30 = venta_diaria(30d)`, `r90 = venta_diaria(90d)` — promedios de
 * ventana, cambian POR DÍA. No hay razón para recomputarlos en cada request. Igual que
 * `rotation_tier`/`sales_units_30d` ya viven denormalizados en `catalog.products`, el
 * momentum pasa a un matview refrescado cada 15 min (AnalyticsRefreshService). La CTE
 * `mom` de Thot se vuelve un join a ~5k filas precomputadas (~ms).
 *
 * `CURRENT_DATE` se congela al refrescar; con refresco cada 15 min las ventanas 30/90d
 * están como mucho 15 min desfasadas — nada, para un promedio de 30/90 días. Llave
 * UNIQUE (tenant_id, product_id) para REFRESH CONCURRENTLY. Sin RLS (analytics.*): Thot
 * filtra `tenant_id` explícito al leer.
 *
 * Idempotente: DROP MATERIALIZED VIEW IF EXISTS + CREATE.
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_product_momentum CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_product_momentum AS
      SELECT tenant_id,
             product_id,
             SUM(COALESCE(units_base, units)) FILTER (WHERE sale_date >= CURRENT_DATE - 30) / 30.0 AS r30,
             SUM(COALESCE(units_base, units)) FILTER (WHERE sale_date >= CURRENT_DATE - 90) / 90.0 AS r90
        FROM analytics.sales_daily
       WHERE sale_date >= CURRENT_DATE - 90
       GROUP BY tenant_id, product_id
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_product_momentum ON analytics.mv_product_momentum (tenant_id, product_id)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_product_momentum TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_product_momentum IS
    'PERF: momentum r30/r90 (venta diaria 30d/90d) precomputado desde sales_daily para ThotService.suggest(). Refresco 15 min (AnalyticsRefreshService). Antes se computaba en vivo por request (~1.4 s); ahora la CTE mom de Thot es un join (~ms).'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_product_momentum CASCADE`);
};
