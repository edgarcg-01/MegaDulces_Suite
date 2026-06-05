/**
 * `trade.planogram_sku_aliases` — mapeo código ERP → producto del planograma.
 *
 * El ticket del vendedor trae solo NOMBRE. El OCR lo matchea contra el set
 * activo ERP (inventory.products_active) y obtiene un `sku`. Para registrar la
 * VISITA con el producto canónico del planograma, necesitamos conectar ese sku
 * con un producto del planograma — pero el mismo producto físico tiene varias
 * variantes/códigos en el ERP (ej. "CANELS 4S" planograma ↔ {00529, 20005,
 * 20058, ...} en el ERP). Esta tabla pre-asigna esos códigos relacionados:
 *
 *   erp_sku (1) → product_id (catalog, canónico del planograma)
 *
 * Uno-a-muchos: muchos erp_sku → un product_id. El bridge del match resuelve
 * sku → product_id por acá (determinístico), robusto a qué variante matchee el
 * OCR. Se siembra con el canónico (cada trade.planogram_skus.sku) y se enriquece
 * con un bootstrap por similitud de nombre + curación manual.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('trade').hasTable('planogram_sku_aliases');
  if (exists) return;

  await knex.schema.withSchema('trade').createTable('planogram_sku_aliases', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('erp_sku', 20).notNullable(); // código del set activo ERP
    table.uuid('product_id').notNullable(); // producto canónico del planograma (catalog.products)
    table.uuid('planogram_sku_id'); // fila de trade.planogram_skus (opcional, referencia)
    table.string('source', 20).notNullable().defaultTo('manual'); // canonical | bootstrap | manual
    table.decimal('confidence', 5, 3); // score del bootstrap (similitud), NULL para canonical/manual

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    // Cada código ERP mapea a UN producto del planograma (entre alias vivos).
    table.index(['tenant_id', 'product_id'], 'idx_trade_psa_product');
  });

  await knex.raw(`
    ALTER TABLE trade.planogram_sku_aliases
      ADD COLUMN activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED
  `);

  // Unique parcial: 1 erp_sku → 1 producto entre alias vivos.
  await knex.raw(`
    CREATE UNIQUE INDEX uniq_trade_psa_tenant_erp_sku
      ON trade.planogram_sku_aliases (tenant_id, erp_sku)
      WHERE deleted_at IS NULL
  `);

  await knex.raw(`
    ALTER TABLE trade.planogram_sku_aliases
      ADD CONSTRAINT fk_trade_psa_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE trade.planogram_sku_aliases
      ADD CONSTRAINT fk_trade_psa_product
      FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE trade.planogram_sku_aliases ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE trade.planogram_sku_aliases FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON trade.planogram_sku_aliases
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON trade.planogram_sku_aliases;
    CREATE TRIGGER trg_auto_populate_tenant_id
      BEFORE INSERT ON trade.planogram_sku_aliases
      FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id();
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON trade.planogram_sku_aliases TO app_runtime');

  await knex.raw(`
    COMMENT ON TABLE trade.planogram_sku_aliases IS
      'Mapeo código ERP (erp_sku) → producto del planograma (product_id catalog). '
      'Uno-a-muchos. Conecta el sku que el OCR obtiene del set activo con el producto '
      'canónico del planograma para la visita. Sembrado canónico + bootstrap + manual.'
  `);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('trade').dropTableIfExists('planogram_sku_aliases');
};
