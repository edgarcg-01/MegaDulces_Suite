/**
 * KV.5 — `analytics.inventory_health`: cruza stock vivo (commercial.stock) con la
 * velocidad de venta (analytics.sales_daily 90d) por producto × almacén →
 * días de cobertura + status (agotado/critico/sano/sobrestock/muerto/nuevo).
 * Reemplaza las alertas de umbral fijo por demanda real.
 *
 * Lo computa `import-inventory-health.js` server-side (prod-interno). Consumido
 * por /comercial/inventory + AlertsScannerService + reporte dead-stock.
 *
 * Aditiva, idempotente, solo schema `analytics`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('inventory_health')) return;
  await knex.raw(`
    CREATE TABLE analytics.inventory_health (
      tenant_id       uuid NOT NULL,
      product_id      uuid NOT NULL,
      warehouse_id    uuid NOT NULL,
      on_hand         numeric DEFAULT 0,
      avg_daily_units numeric DEFAULT 0,
      days_cover      numeric,
      status          text,
      computed_at     timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id, warehouse_id)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_invhealth_status ON analytics.inventory_health (tenant_id, status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_invhealth_wh ON analytics.inventory_health (tenant_id, warehouse_id)`);
  await knex.raw(`GRANT SELECT ON analytics.inventory_health TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('inventory_health');
};
