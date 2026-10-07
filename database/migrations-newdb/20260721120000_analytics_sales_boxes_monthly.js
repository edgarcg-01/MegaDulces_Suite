/**
 * RS.3 — `analytics.sales_boxes_monthly`: rollup mensual de venta EN CAJAS por
 * producto × almacén × canal × mes, derivado de `analytics.sales_daily` (ya con
 * unidad normalizada + unit_kind). Persiste la "info en cajas" que el sell-out
 * calculaba al vuelo:
 *   · producto de PIEZA → pieces (canónico) + boxes = pieces / uxc (factor/box_size)
 *   · producto de PESO  → kg (canónico); boxes = NULL (el granel no va en cajas)
 * Lo alimenta el feed on-prem `import-sales-boxes-monthly.js`. Aditiva, idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('sales_boxes_monthly'))) {
    await knex.raw(`
      CREATE TABLE analytics.sales_boxes_monthly (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        product_id   uuid NOT NULL,
        warehouse_id uuid NOT NULL,
        channel      text NOT NULL,
        year_month   text NOT NULL,               -- 'YYYY-MM'
        unit_kind    text,                          -- 'piece' | 'weight'
        pieces       numeric,                       -- canónico en piezas (null si peso)
        kg           numeric,                       -- canónico en kg (null si pieza)
        boxes        numeric,                       -- cajas = pieces / uxc (null si peso)
        uxc          numeric,                       -- divisor usado (factor_sale o box_size)
        revenue      numeric NOT NULL DEFAULT 0,
        tickets      integer NOT NULL DEFAULT 0,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sales_boxes_monthly_kind_check CHECK (unit_kind IS NULL OR unit_kind IN ('piece','weight'))
      )`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_boxes_monthly ON analytics.sales_boxes_monthly (tenant_id, product_id, warehouse_id, channel, year_month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_boxes_monthly_month ON analytics.sales_boxes_monthly (tenant_id, year_month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_boxes_monthly_prod ON analytics.sales_boxes_monthly (tenant_id, product_id)`);
  await knex.raw(`GRANT SELECT ON analytics.sales_boxes_monthly TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('sales_boxes_monthly');
};
