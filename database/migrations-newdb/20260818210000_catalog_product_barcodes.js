/**
 * `catalog.product_barcodes` — un SKU tiene VARIOS códigos de barras, uno por UNIDAD.
 *
 * `catalog.products.barcode` es escalar y solo guarda el EAN de la PIEZA (Kepler `kdii.c7`).
 * Pero un producto trae otro EAN por la CAJA/paquete (`kdii.c82`, unidad `c83`, factor `c81`) y
 * Wincaja guarda el de su unidad de compra. Al escanear la caja, el barcode "no existe / se ve
 * desactualizado" porque el modelo escalar no lo puede representar. Esta tabla es el 1→N:
 * cada (sku, barcode) con su unidad + factor + fuente, para que el lookup por escaneo resuelva
 * a SKU + qué unidad se escaneó. `catalog.products.barcode` sigue siendo el PRIMARIO (pieza) que
 * se muestra. Poblada por `import-product-barcodes.js` (Kepler c7+c82 ∪ Wincaja). Aditivo:
 * NO toca `catalog.products`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('catalog').hasTable('product_barcodes');
  if (exists) return;

  await knex.schema.withSchema('catalog').createTable('product_barcodes', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('sku', 40).notNullable();
    table.string('barcode', 40).notNullable();
    table.string('unit', 16);            // PZA | CJA | PAQ | ... (unidad a la que aplica el barcode)
    table.decimal('factor');             // piezas por unidad (1=pieza, 6=caja x6, ...)
    table.string('source', 20).notNullable(); // kepler_pza | kepler_cja | wincaja
    table.boolean('is_primary').notNullable().defaultTo(false); // el de la pieza/base que se muestra

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('synced_at');
    table.timestamp('deleted_at');

    table.primary('id');
    table.index(['tenant_id', 'sku'], 'idx_catalog_product_barcodes_sku');
  });

  await knex.raw(`
    ALTER TABLE catalog.product_barcodes
      ADD COLUMN activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED
  `);

  // Un (sku, barcode) único entre vivos → UPSERT idempotente del importer.
  await knex.raw(`
    CREATE UNIQUE INDEX uniq_catalog_product_barcodes
      ON catalog.product_barcodes (tenant_id, sku, barcode)
      WHERE deleted_at IS NULL
  `);
  // Lookup por escaneo: barcode → producto+unidad (NO único: la data cruda tiene colisiones).
  await knex.raw(`
    CREATE INDEX idx_catalog_product_barcodes_lookup
      ON catalog.product_barcodes (tenant_id, barcode)
      WHERE deleted_at IS NULL
  `);

  await knex.raw('ALTER TABLE catalog.product_barcodes ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE catalog.product_barcodes FORCE ROW LEVEL SECURITY');
  await knex.raw(`
    CREATE POLICY tenant_isolation ON catalog.product_barcodes
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON catalog.product_barcodes;
    CREATE TRIGGER trg_auto_populate_tenant_id
      BEFORE INSERT ON catalog.product_barcodes
      FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id();
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.product_barcodes TO app_runtime');

  await knex.raw(`
    COMMENT ON TABLE catalog.product_barcodes IS
      'Códigos de barras por SKU y UNIDAD (1→N). Un SKU trae un EAN por pieza (Kepler c7) y otro '
      'por caja/paquete (Kepler c82, unidad c83, factor c81); Wincaja aporta el de su unidad de '
      'compra. Lookup de escaneo: barcode → sku + unidad. catalog.products.barcode = primario (pieza).'
  `);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('catalog').dropTableIfExists('product_barcodes');
};
