/**
 * KV.2 — `analytics.product_sales_stats`: rolling 30/90/365d + clasificación ABC
 * + participación %, computado server-side desde `analytics.sales_daily` (KV.1).
 *
 * Lo alimenta `import-sales-stats.js` (un INSERT...SELECT...ON CONFLICT, sin
 * shipping de filas — barato incluso contra prod). Consumido por command-center
 * (sales-by-brand/top-products sobre venta real) y Thot (rotación/share real).
 *
 * Aditiva, idempotente, solo schema `analytics`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('product_sales_stats')) return;
  await knex.raw(`
    CREATE TABLE analytics.product_sales_stats (
      tenant_id         uuid NOT NULL,
      product_id        uuid NOT NULL,
      units_30d         numeric DEFAULT 0,
      revenue_30d       numeric DEFAULT 0,
      units_90d         numeric DEFAULT 0,
      revenue_90d       numeric DEFAULT 0,
      units_365d        numeric DEFAULT 0,
      revenue_365d      numeric DEFAULT 0,
      abc_class         char(1),
      revenue_share_pct numeric,
      computed_at       timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_pss_abc ON analytics.product_sales_stats (tenant_id, abc_class)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_pss_rev ON analytics.product_sales_stats (tenant_id, revenue_365d DESC)`);
  await knex.raw(`GRANT SELECT ON analytics.product_sales_stats TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('product_sales_stats');
};
