/**
 * KV.3 — Customer 360 desde venta real, SIN tocar commercial.customers (decisión
 * del usuario: solo historial en analytics.*).
 *   analytics.erp_customers       — dim de clientes Kepler (maestro kdud, limpio).
 *   analytics.customer_product_sales — qué compró cada cliente (mart.ventas 90/180d).
 *
 * Key = erp_code (código Kepler normalizado: numéricos a 5 dígitos con lpad).
 * Clientes TI00x (transferencias/mayoreo interno) entran en el historial pero no
 * tienen fila en la dim (no son clientes nominales). CONTADO (mostrador) se excluye.
 *
 * Aditiva, idempotente, solo schema `analytics`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('erp_customers'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_customers (
        tenant_id   uuid NOT NULL,
        erp_code    text NOT NULL,
        name        text,
        rfc         text,
        city        text,
        computed_at timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, erp_code)
      )`);
    await knex.raw(`GRANT SELECT ON analytics.erp_customers TO app_runtime`);
  }
  if (!(await knex.schema.withSchema('analytics').hasTable('customer_product_sales'))) {
    await knex.raw(`
      CREATE TABLE analytics.customer_product_sales (
        tenant_id          uuid NOT NULL,
        erp_code           text NOT NULL,
        product_id         uuid NOT NULL,
        units_90d          numeric DEFAULT 0,
        revenue_90d        numeric DEFAULT 0,
        units_180d         numeric DEFAULT 0,
        revenue_180d       numeric DEFAULT 0,
        last_purchase_date date,
        computed_at        timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, erp_code, product_id)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cps_code ON analytics.customer_product_sales (tenant_id, erp_code)`);
    await knex.raw(`GRANT SELECT ON analytics.customer_product_sales TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('customer_product_sales');
  await knex.schema.withSchema('analytics').dropTableIfExists('erp_customers');
};
