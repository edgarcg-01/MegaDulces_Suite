/**
 * DM.5 — el feed NO debe perder líneas por SKUs fuera de catálogo.
 *
 * Caso real (recepción 0000102@03): 18 líneas / 1,124 pzs en Kepler, pero el feed
 * guardaba 16 / 514 porque 2 SKUs (30546, 91100 = 610 pzs) no existen en
 * public.products → el importer las saltaba → totales falsos → estados de
 * traspaso "diferencia" FANTASMA en la validación salida↔recepción.
 *
 * Fix: product_id nullable + columna sku (denormalizada, siempre presente).
 * Idempotente. analytics.* sin RLS.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('analytics').hasTable('stock_movements');
  if (!has) return;
  await knex.raw(`ALTER TABLE analytics.stock_movements ALTER COLUMN product_id DROP NOT NULL`);
  if (!(await knex.schema.withSchema('analytics').hasColumn('stock_movements', 'sku'))) {
    await knex.raw(`ALTER TABLE analytics.stock_movements ADD COLUMN sku text`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.stock_movements DROP COLUMN IF EXISTS sku`);
};
