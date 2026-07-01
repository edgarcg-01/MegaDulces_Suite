/**
 * RR.1 — Tabla `analytics.sales_by_route_monthly`: VENTA REAL por
 * sucursal × RUTA × mes. La ruta = serie del folio Kepler `kdm1.c63`
 * (formato `UD`+almacén+ruta, ej. `UD1003` = PH ruta 03 = "md_01-003").
 * Venta = docs `c2='U' c3='D' c4=10` (unidades c9, importe c13, ticket c6).
 *
 * La alimenta el feed on-prem `import-sales-by-route-monthly.js`, que hace
 * UPSERT-acumulativo (GREATEST): los servidores de sucursal EN VIVO purgan
 * historia (PH retiene ~días), así que el feed nunca borra un mes ya capturado
 * — solo sube el valor cuando la fuente trae más. Historia por ruta se
 * construye HACIA ADELANTE.
 *
 * Aditiva, idempotente, solo schema `analytics`. NO toca mart.ventas ni trade.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('sales_by_route_monthly')) return;
  await knex.raw(`
    CREATE TABLE analytics.sales_by_route_monthly (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL,
      warehouse_id uuid NOT NULL,
      route_code   text NOT NULL,
      route_no     text,
      month        date NOT NULL,
      units        numeric NOT NULL DEFAULT 0,
      revenue      numeric NOT NULL DEFAULT 0,
      tickets      integer NOT NULL DEFAULT 0,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sbrm ON analytics.sales_by_route_monthly (tenant_id, warehouse_id, route_code, month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sbrm_month ON analytics.sales_by_route_monthly (tenant_id, month)`);
  await knex.raw(`GRANT SELECT ON analytics.sales_by_route_monthly TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('sales_by_route_monthly');
};
