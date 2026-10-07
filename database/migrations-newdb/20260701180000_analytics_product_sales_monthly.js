/**
 * SAL.1 — Tabla `analytics.product_sales_monthly`: VENTA REAL por
 * producto × sucursal × mes, tomada DIRECTO de los servidores Kepler de
 * sucursal EN VIVO (192.168.x) con el filtro de venta `c2='U' c3='D' c4=10`
 * (unidades, sin el fanout c4=6/c4=10 que duplica en mart.ventas).
 *
 * Base del reporte "Salidas/Ventas por Producto" (/comercial/salidas). La
 * alimenta el feed on-prem `import-product-sales-monthly.js`.
 *
 * Aditiva, idempotente, solo schema `analytics`. NO toca trade marketing / ruta.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('product_sales_monthly')) return;
  await knex.raw(`
    CREATE TABLE analytics.product_sales_monthly (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL,
      product_id   uuid NOT NULL,
      warehouse_id uuid NOT NULL,
      month        date NOT NULL,
      units        numeric NOT NULL DEFAULT 0,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_psm ON analytics.product_sales_monthly (tenant_id, product_id, warehouse_id, month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_psm_month ON analytics.product_sales_monthly (tenant_id, month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_psm_prod ON analytics.product_sales_monthly (tenant_id, product_id)`);
  await knex.raw(`GRANT SELECT ON analytics.product_sales_monthly TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('product_sales_monthly');
};
