/**
 * + catalog.products.sales_units_90d (unidades vendidas 90d).
 *
 * El stock muerto se mide con ventana de 90d (no 30d, que flaggea estacionales
 * como falsos positivos). El feed de rotación Kepler computa u90; acá lo persiste.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('catalog').hasColumn('products', 'sales_units_90d'))) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => t.integer('sales_units_90d'));
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('catalog').hasColumn('products', 'sales_units_90d')) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => t.dropColumn('sales_units_90d'));
  }
};
