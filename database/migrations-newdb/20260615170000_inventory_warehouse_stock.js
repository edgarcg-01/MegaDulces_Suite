/**
 * Fase I — soporte para inventario físico sobre el catálogo del almacén
 * (inventory.products, identificado por sku), no solo sobre catalog.products.
 *
 * En prod, catalog.products = solo productos de trade (intocable). Los productos
 * reales del almacén con código de barras viven en inventory.products (sin uuid,
 * por sku). Para contar sobre ellos:
 *
 *   - inventory.warehouse_stock: existencia por (almacén, sku). Fuente del
 *     snapshot del folio cuando el almacén es "inventory-based".
 *   - inventory_count_items: + product_sku (nullable) y product_id pasa a
 *     nullable sin FK obligatoria a catalog.products (los items pueden venir de
 *     inventory.products por sku).
 *
 * Aditivo e idempotente. No rompe el modo existente (commercial.stock +
 * catalog.products por uuid).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── inventory.warehouse_stock ──
  if (!(await knex.schema.withSchema('inventory').hasTable('warehouse_stock'))) {
    await knex.schema.withSchema('inventory').createTable('warehouse_stock', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('warehouse_id').notNullable();
      t.string('sku', 40).notNullable();
      t.decimal('quantity', 14, 3).notNullable().defaultTo(0);
      t.decimal('reserved_quantity', 14, 3).notNullable().defaultTo(0);
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id', 'warehouse_id', 'sku'], { indexName: 'inventory_warehouse_stock_unique' });
      t.index(['tenant_id', 'warehouse_id'], 'idx_inventory_warehouse_stock_wh');
    });
    await knex.raw(`ALTER TABLE inventory.warehouse_stock ADD CONSTRAINT fk_inv_wh_stock_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE inventory.warehouse_stock ADD CONSTRAINT fk_inv_wh_stock_warehouse FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE inventory.warehouse_stock ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE inventory.warehouse_stock FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON inventory.warehouse_stock`);
    await knex.raw(`CREATE POLICY tenant_isolation ON inventory.warehouse_stock USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.warehouse_stock TO app_runtime`);
  }

  // ── inventory_count_items: product_sku + product_id nullable, sin FK obligatoria ──
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_count_items', 'product_sku'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => {
      t.string('product_sku', 40);
    });
  }
  await knex.raw(`ALTER TABLE commercial.inventory_count_items ALTER COLUMN product_id DROP NOT NULL`);
  await knex.raw(`ALTER TABLE commercial.inventory_count_items DROP CONSTRAINT IF EXISTS fk_commercial_inv_items_product`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_commercial_inv_items_sku ON commercial.inventory_count_items (tenant_id, count_id, product_sku)`);

  // Flag en el folio para saber la fuente de stock del almacén.
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'stock_source'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => {
      t.string('stock_source', 12).notNullable().defaultTo('commercial'); // 'commercial' | 'inventory'
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('inventory').dropTableIfExists('warehouse_stock');
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_count_items', 'product_sku')) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => t.dropColumn('product_sku'));
  }
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'stock_source')) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => t.dropColumn('stock_source'));
  }
};
