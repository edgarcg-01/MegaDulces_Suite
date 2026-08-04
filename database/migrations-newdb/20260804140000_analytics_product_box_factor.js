/**
 * RA-PRO.37 — `analytics.product_box_factor`: factor de caja AUTORITATIVO desde
 * Kepler `kdii.c84` (piezas por caja). Descubierto 2026-08-04: c84 es la
 * conversión a caja que el propio ERP maneja (verificado 17/17 vs etiquetera).
 *
 * Reemplaza la adivinanza por el "/N" del nombre / factor_sale roto. El feed
 * `import-box-factor.js` lo puebla (MAX c84>1 entre sucursales) y el
 * `import-replenishment-plan.js` lo usa como TOPE de precedencia del uxc
 * (por encima de etiquetera y factor_sale; el override manual sigue ganando).
 *
 * Sin RLS (schema analytics) → todo consumidor filtra tenant_id explícito.
 * Aditiva, idempotente (hasTable guard). GRANT SELECT app_runtime.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('product_box_factor')) return;
  await knex.raw(`
    CREATE TABLE analytics.product_box_factor (
      tenant_id   uuid NOT NULL,
      product_id  uuid NOT NULL,
      box_factor  numeric NOT NULL,
      source      text NOT NULL DEFAULT 'kepler_c84',
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id)
    )`);
  await knex.raw(`GRANT SELECT ON analytics.product_box_factor TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('product_box_factor');
};
