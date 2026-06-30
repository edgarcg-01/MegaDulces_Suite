/**
 * KV.4 — `catalog.products.markup_pct`: markup % sobre costo del ERP Kepler
 * (kdpv_prod_util.c6, promedio de tiers de volumen por SKU). Permite derivar
 * costo/margen de la venta sin el lío de unidades de cost_base:
 *   cost = revenue / (1 + markup_pct/100)   ·   margin = revenue - cost
 *
 * c6 es MARKUP sobre costo (no margen sobre precio): llega a >100% (imposible
 * para un margen). Lo alimenta `import-margin.js` (lee una sucursal Kepler);
 * lo consume `import-sales-fact.js` (cost de sales_daily) y Thot (señal margen).
 *
 * Aditiva, idempotente, solo schema `catalog`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('catalog').hasColumn('products', 'markup_pct'))) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.decimal('markup_pct', 10, 4).nullable();
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('catalog').hasColumn('products', 'markup_pct')) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.dropColumn('markup_pct');
    });
  }
};
