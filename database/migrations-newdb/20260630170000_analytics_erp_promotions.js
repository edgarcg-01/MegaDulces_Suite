/**
 * KV.6 — `analytics.erp_promotions`: reglas de promoción VIGENTES del ERP Kepler
 * (kdpv_descuxq/gratisxq/descuxm/gratisxm). Señal para Thot ("promo activa") y
 * portal/vendedor. Refresco full (TRUNCATE+INSERT) — el set vigente es chico.
 *
 * promo_type: descuento_qty | gratis_qty | descuento_monto | gratis_monto.
 * threshold = qty o monto mínimo · benefit = descuento o cantidad gratis.
 *
 * Aditiva, idempotente, solo schema `analytics`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('erp_promotions')) return;
  await knex.raw(`
    CREATE TABLE analytics.erp_promotions (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       uuid NOT NULL,
      product_id      uuid NOT NULL,
      promo_type      text NOT NULL,
      threshold       numeric,
      benefit         numeric,
      free_product_id uuid,
      valid_from      date,
      valid_to        date,
      warehouse_code  text,
      raw_name        text,
      computed_at     timestamptz DEFAULT now()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_erp_promos_prod ON analytics.erp_promotions (tenant_id, product_id)`);
  await knex.raw(`GRANT SELECT ON analytics.erp_promotions TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('erp_promotions');
};
