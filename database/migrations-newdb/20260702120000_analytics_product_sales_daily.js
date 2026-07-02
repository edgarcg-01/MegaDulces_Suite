/**
 * SAL.5.1 — Tabla `analytics.product_sales_daily`: VENTA REAL por
 * producto × sucursal × DÍA (unidades), tomada DIRECTO de los servidores Kepler
 * de sucursal EN VIVO con el filtro de venta `c2='U' c3='D' c4=10` — MISMA fuente
 * y filtro que `product_sales_monthly`, solo que a grano diario.
 *
 * Habilita el modo RANGO del reporte /comercial/salidas (Últimos 7/15/30 días +
 * personalizado con calendario). Se eligió NO reusar analytics.sales_daily porque
 * NO reconcilia con product_sales_monthly (~5% abajo + excluye SKUs como TIEMPO
 * AIRE) → año y rango darían números distintos.
 *
 * La alimenta el feed on-prem `import-product-sales-daily.js` con UPSERT
 * acumulativo (GREATEST) — las sucursales vivas purgan historia (PH ~días).
 *
 * Aditiva, idempotente, solo schema `analytics`. NO toca mart.ventas ni trade.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('product_sales_daily')) return;
  await knex.raw(`
    CREATE TABLE analytics.product_sales_daily (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL,
      product_id   uuid NOT NULL,
      warehouse_id uuid NOT NULL,
      sale_date    date NOT NULL,
      units        numeric NOT NULL DEFAULT 0,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_psd ON analytics.product_sales_daily (tenant_id, product_id, warehouse_id, sale_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_psd_date ON analytics.product_sales_daily (tenant_id, sale_date)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_psd_prod ON analytics.product_sales_daily (tenant_id, product_id)`);
  await knex.raw(`GRANT SELECT ON analytics.product_sales_daily TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('product_sales_daily');
};
