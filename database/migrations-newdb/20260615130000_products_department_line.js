/**
 * Agrega taxonomía real de producto a catalog.products: department + product_line.
 *
 * Hasta ahora `category_id` apunta a categories que en realidad son PROVEEDORES.
 * Kepler tiene la taxonomía real: departamento (kdie: DULCES/BEBIDAS/BOTANAS) y
 * línea (kdif: CHOCOLATE PASTELITO/AGUA EMBOTELLADA). Se importan a estos campos
 * sin tocar el category_id=proveedor existente.
 *
 * Idempotente (hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = async (col) => knex.schema.withSchema('catalog').hasColumn('products', col);
  if (!(await has('department'))) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.string('department', 60);
    });
  }
  if (!(await has('product_line'))) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.string('product_line', 60);
    });
  }
  await knex.raw(`COMMENT ON COLUMN catalog.products.department IS 'Departamento (taxonomía real Kepler kdie: DULCES/BEBIDAS/BOTANAS). Distinto de category_id (=proveedor).'`);
  await knex.raw(`COMMENT ON COLUMN catalog.products.product_line IS 'Línea/sub-categoría (Kepler kdif: CHOCOLATE PASTELITO, AGUA EMBOTELLADA).'`);
};

exports.down = async function (knex) {
  const has = async (col) => knex.schema.withSchema('catalog').hasColumn('products', col);
  if (await has('department')) await knex.schema.withSchema('catalog').alterTable('products', (t) => t.dropColumn('department'));
  if (await has('product_line')) await knex.schema.withSchema('catalog').alterTable('products', (t) => t.dropColumn('product_line'));
};
