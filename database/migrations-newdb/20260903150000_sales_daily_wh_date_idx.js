/**
 * HOTFIX de performance — índice `(tenant_id, warehouse_id, sale_date)` en `analytics.sales_daily`.
 *
 * La pierna (b) del pivote híbrido de sellOut lee las RUTAS NUMERADAS de sales_daily filtrando por
 * `w.code LIKE 'RUTA-%'` (join a warehouses) + rango de fecha. Sin este índice el planner hacía Seq Scan
 * de sales_daily (~900k filas) → para un rango ancho (full-year) tardaba 70s → 500 (statement timeout
 * 57014) en `GET /commercial/analytics/sell-out`. Con el índice, la pierna de rutas baja a ~4s.
 *
 * Aplicado a prod con CREATE INDEX CONCURRENTLY (sin lock, sales_daily es de lectura viva). Este archivo
 * usa CREATE IF NOT EXISTS (no-concurrent) para el deploy: en prod ya existe → no-op; en entornos nuevos
 * lo crea (sales_daily chico ahí). NUNCA editar una migración aplicada; ésta es idempotente.
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_daily_wh_date
    ON analytics.sales_daily (tenant_id, warehouse_id, sale_date)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ix_sales_daily_wh_date`);
};
