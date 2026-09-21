/**
 * HOTFIX de performance — índice `(tenant_id, sale_date)` en `analytics.sales_daily`.
 *
 * El resumen ejecutivo de Presupuestos (GET budgets/:id/summary, bloque «real») agrega sales_daily
 * filtrando por `tenant_id + sale_date BETWEEN` (SIN warehouse_id). El índice existente
 * `ix_sales_daily_wh_date (tenant_id, warehouse_id, sale_date)` lleva warehouse_id en medio → ese
 * filtro no lo aprovecha y el planner cae a Parallel Seq Scan de toda la tabla (medido: 641k filas,
 * lee ~587k para un año). En prod (tabla mayor + latencia de red) el seq scan escala a decenas de
 * segundos. Con `(tenant_id, sale_date)` el año es un range scan ajustado.
 *
 * En prod aplicar con `CREATE INDEX CONCURRENTLY` (sin lock; sales_daily es de lectura viva). Este
 * archivo usa CREATE IF NOT EXISTS (no-concurrent) para el deploy en entornos nuevos (tabla chica).
 * NUNCA editar una migración aplicada; ésta es idempotente.
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_daily_tenant_date
    ON analytics.sales_daily (tenant_id, sale_date)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ix_sales_daily_tenant_date`);
};
