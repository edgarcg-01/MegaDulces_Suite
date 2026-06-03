/**
 * Sprint imágenes — extiende CHECK constraint de products.image_source para
 * incluir 'ml' (Mercado Libre).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_image_source_check`);
  await knex.raw(`
    ALTER TABLE products
      ADD CONSTRAINT products_image_source_check
      CHECK (image_source IS NULL OR image_source IN ('off', 'ml', 'google', 'manual', 'vendor'))
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_image_source_check`);
  await knex.raw(`
    ALTER TABLE products
      ADD CONSTRAINT products_image_source_check
      CHECK (image_source IS NULL OR image_source IN ('off', 'google', 'manual', 'vendor'))
  `);
};
