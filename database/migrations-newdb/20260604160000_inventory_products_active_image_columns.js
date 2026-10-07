/**
 * Agrega columnas de imagen a `inventory.products_active` (mismo patrón que
 * inventory.products). Las URLs se propagan desde inventory.products via SKU.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE inventory.products_active
      ADD COLUMN IF NOT EXISTS image_url text,
      ADD COLUMN IF NOT EXISTS image_source varchar(20),
      ADD COLUMN IF NOT EXISTS image_storage_key varchar(255),
      ADD COLUMN IF NOT EXISTS image_updated_at timestamptz
  `);

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_inventory_products_active_with_image ON inventory.products_active (sku) WHERE image_url IS NOT NULL`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS inventory.idx_inventory_products_active_with_image`);
  await knex.raw(`
    ALTER TABLE inventory.products_active
      DROP COLUMN IF EXISTS image_url,
      DROP COLUMN IF EXISTS image_source,
      DROP COLUMN IF EXISTS image_storage_key,
      DROP COLUMN IF EXISTS image_updated_at
  `);
};
