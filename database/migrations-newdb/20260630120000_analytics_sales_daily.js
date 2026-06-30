/**
 * KV.1 — Tabla `analytics.sales_daily`: fact de VENTA REAL de la red Kepler
 * (6 sucursales, consolidación on-prem) por producto × almacén × canal × día.
 * La alimenta el feed on-prem `import-sales-fact.js` (ventana 13 meses, bulk).
 *
 * Base de KV.2 (ABC/participación), KV.4 (margen) y KV.5 (demanda). Reemplaza el
 * reporting de Fase C que leía `commercial.orders` (casi vacío en beta) por venta
 * real. `margin` es GENERATED (revenue-cost), no se escribe.
 *
 * Aditiva, idempotente, solo schema `analytics`. NO toca trade marketing / ruta.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('sales_daily')) return;
  await knex.raw(`
    CREATE TABLE analytics.sales_daily (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL,
      product_id   uuid NOT NULL,
      warehouse_id uuid NOT NULL,
      channel      text NOT NULL,
      sale_date    date NOT NULL,
      units        numeric NOT NULL DEFAULT 0,
      revenue      numeric NOT NULL DEFAULT 0,
      cost         numeric NOT NULL DEFAULT 0,
      margin       numeric GENERATED ALWAYS AS (revenue - cost) STORED,
      tickets      integer NOT NULL DEFAULT 0,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_daily ON analytics.sales_daily (tenant_id, product_id, warehouse_id, channel, sale_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_daily_date ON analytics.sales_daily (tenant_id, sale_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_daily_prod ON analytics.sales_daily (tenant_id, product_id)`);
  await knex.raw(`GRANT SELECT ON analytics.sales_daily TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('sales_daily');
};
