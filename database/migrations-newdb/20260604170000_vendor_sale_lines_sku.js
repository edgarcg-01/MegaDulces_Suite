/**
 * `commercial.vendor_sale_lines` → identificar por SKU (set activo ERP).
 *
 * La venta del vendedor ahora matchea contra `inventory.products_active` (6489),
 * que se identifica por `sku` (no tiene UUID). Antes la columna `product_id`
 * (FK → catalog.products) asumía que todo lo vendido estaba en el catálogo
 * comercial curado (1199), lo que descartaba ventas fuera de ese set.
 *
 * Cambios:
 *   - ADD `sku varchar(20)` + índice (tenant_id, sku).
 *   - DROP FK `fk_vendor_sale_lines_product` y hacer `product_id` NULLABLE
 *     (se setea solo si el sku ∈ catalog.products; opcional para BI comercial).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasSku = await knex.schema.hasColumn('commercial.vendor_sale_lines', 'sku');
  if (!hasSku) {
    await knex.schema.withSchema('commercial').alterTable('vendor_sale_lines', (t) => {
      t.string('sku', 20);
      t.index(['tenant_id', 'sku'], 'idx_commercial_vsl_sku');
    });
  }

  // Drop FK product_id→catalog (si existe) + product_id nullable.
  await knex.raw(
    'ALTER TABLE commercial.vendor_sale_lines DROP CONSTRAINT IF EXISTS fk_vendor_sale_lines_product',
  );
  await knex.raw('ALTER TABLE commercial.vendor_sale_lines ALTER COLUMN product_id DROP NOT NULL');

  await knex.raw(`
    COMMENT ON COLUMN commercial.vendor_sale_lines.sku IS
      'SKU del producto ERP (inventory.products_active). Identificador principal de la venta.'
  `);
};

exports.down = async function (knex) {
  const hasSku = await knex.schema.hasColumn('commercial.vendor_sale_lines', 'sku');
  if (hasSku) {
    await knex.schema.withSchema('commercial').alterTable('vendor_sale_lines', (t) => {
      t.dropIndex(['tenant_id', 'sku'], 'idx_commercial_vsl_sku');
      t.dropColumn('sku');
    });
  }
  // No re-agregamos el FK ni el NOT NULL en down (data podría tener product_id null).
};
