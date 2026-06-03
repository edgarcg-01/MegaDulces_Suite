/**
 * Sprint imágenes catálogo — agrega columnas para almacenar URL de imagen
 * de producto + metadata de procedencia.
 *
 * Columnas agregadas a `products`:
 *   - image_url          TEXT          URL pública del bucket (S3 Railway)
 *   - image_source       VARCHAR(20)   'off' | 'google' | 'manual' | 'vendor'
 *   - image_storage_key  TEXT          key dentro del bucket (para borrar/reemplazar)
 *   - image_updated_at   TIMESTAMPTZ   última vez que se actualizó la foto
 *
 * Todas nullable + idempotentes. No rompe runtime.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS image_url         TEXT,
      ADD COLUMN IF NOT EXISTS image_source      VARCHAR(20),
      ADD COLUMN IF NOT EXISTS image_storage_key TEXT,
      ADD COLUMN IF NOT EXISTS image_updated_at  TIMESTAMPTZ
  `);

  await knex.raw(`
    ALTER TABLE products
      DROP CONSTRAINT IF EXISTS products_image_source_check
  `);
  await knex.raw(`
    ALTER TABLE products
      ADD CONSTRAINT products_image_source_check
      CHECK (image_source IS NULL OR image_source IN ('off', 'google', 'manual', 'vendor'))
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_tenant_has_image
      ON products (tenant_id)
      WHERE image_url IS NOT NULL AND deleted_at IS NULL
  `);

  await knex.raw(`COMMENT ON COLUMN products.image_url IS 'URL pública del bucket. NULL = sin foto cargada.'`);
  await knex.raw(`COMMENT ON COLUMN products.image_source IS 'Procedencia: off=Open Food Facts, google=Google CSE, manual=upload backoffice, vendor=app vendedor.'`);
  await knex.raw(`COMMENT ON COLUMN products.image_storage_key IS 'Key del objeto en el bucket S3 (sin host). Útil para delete/replace.'`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_products_tenant_has_image`);
  await knex.raw(`
    ALTER TABLE products
      DROP CONSTRAINT IF EXISTS products_image_source_check,
      DROP COLUMN IF EXISTS image_url,
      DROP COLUMN IF EXISTS image_source,
      DROP COLUMN IF EXISTS image_storage_key,
      DROP COLUMN IF EXISTS image_updated_at
  `);
};
