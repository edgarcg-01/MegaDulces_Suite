/**
 * HVT.1 — `analytics.sales_monthly`: rollup MENSUAL durable de la venta real
 * (producto × almacén × canal × mes) desde `analytics.sales_daily`.
 *
 * Por qué: `sales_daily` son ~4.2M filas / 2.7GB (ventana viva 2 años) — pesado para
 * series largas. El mensual es ~50× más chico, rápido, y retiene historia sin bloat.
 * Es la serie larga para el histórico de venta (Fase HVT) y el insumo de la
 * investigación de calibración de demanda (demanda real vs reorder_policy).
 *
 * Sin RLS (schema analytics) → filtro tenant_id explícito en los consumidores.
 * Idempotente (hasTable guard). Lo llena el feed import-sales-monthly.js con guard
 * de fechas (descarta basura 2000/2014/2020 y futuros como 2026-12-06 de wincaja_ruta).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('sales_monthly')) return;
  await knex.raw(`
    CREATE TABLE analytics.sales_monthly (
      tenant_id    uuid NOT NULL,
      product_id   uuid NOT NULL,
      warehouse_id uuid NOT NULL,
      channel      text NOT NULL,
      month        date NOT NULL,          -- primer día del mes (date_trunc)
      units        numeric NOT NULL DEFAULT 0,
      revenue      numeric NOT NULL DEFAULT 0,
      cost         numeric,
      tickets      integer NOT NULL DEFAULT 0,
      unit_kind    text,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id, warehouse_id, channel, month)
    )`);
  await knex.raw(`CREATE INDEX idx_sales_monthly_prod_month ON analytics.sales_monthly (tenant_id, product_id, month)`);
  await knex.raw(`CREATE INDEX idx_sales_monthly_month ON analytics.sales_monthly (tenant_id, month)`);
  await knex.raw(`GRANT SELECT ON analytics.sales_monthly TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('sales_monthly');
};
