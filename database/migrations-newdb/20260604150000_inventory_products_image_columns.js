/**
 * Agrega columnas de imagen a `inventory.products` para almacenar URLs de
 * Cloudinary (o cualquier fuente externa).
 *
 * Mismo patrón que `catalog.products`:
 *   - image_url: URL pública servible
 *   - image_source: 'cloudinary' | 'erp' | 'manual' | etc.
 *   - image_storage_key: public_id de Cloudinary (necesario para borrar/transformar)
 *   - image_updated_at: timestamp del último upload
 *
 * Idempotente (IF NOT EXISTS).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE inventory.products
      ADD COLUMN IF NOT EXISTS image_url text,
      ADD COLUMN IF NOT EXISTS image_source varchar(20),
      ADD COLUMN IF NOT EXISTS image_storage_key varchar(255),
      ADD COLUMN IF NOT EXISTS image_updated_at timestamptz
  `);

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_inventory_products_with_image ON inventory.products (sku) WHERE image_url IS NOT NULL`,
  );

  await knex.raw(
    `COMMENT ON COLUMN inventory.products.image_url IS 'URL pública servible (Cloudinary u otra fuente externa).'`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS inventory.idx_inventory_products_with_image`);
  await knex.raw(`
    ALTER TABLE inventory.products
      DROP COLUMN IF EXISTS image_url,
      DROP COLUMN IF EXISTS image_source,
      DROP COLUMN IF EXISTS image_storage_key,
      DROP COLUMN IF EXISTS image_updated_at
  `);
};
