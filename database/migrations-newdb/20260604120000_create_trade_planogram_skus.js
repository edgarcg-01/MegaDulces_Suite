/**
 * Fase L.6 — Crear `trade.planogram_skus`.
 *
 * Objetivo: separar el universo de productos en 2 capas:
 *   - `catalog.products` (MASTER: 12,348 SKUs — todos los del ERP)
 *   - `trade.planogram_skus` (CURADO: 1,199 SKUs subset, los que efectivamente
 *     se exhiben y se auditan en PdV)
 *
 * Cada row es un SKU "elegible para planograma" con metadata propia:
 *   - orden_exhibicion: posición sugerida en la pared del PdV
 *   - categoria_exhibicion: bucket visual ("chocolates premium", "caja chica")
 *   - posicion_shelf: JSONB con shelf coordinates (opcional, para futuras
 *     features tipo "primer plano vs estante inferior")
 *   - vigente_desde / vigente_hasta: rango temporal (rotación de planograma)
 *
 * FK `product_id → catalog.products(id)` con CASCADE para que si se borra el
 * producto master se borre también del planograma. UNIQUE (tenant_id, sku)
 * permite que el mismo SKU pertenezca a distintos planogramas de distintos
 * tenants pero NO se duplique dentro de un mismo tenant.
 *
 * Multi-tenant: tenant_id + RLS forzada + trigger auto_populate_tenant_id (mismo
 * patrón que el resto de tablas trade).
 *
 * ADR-015 — Schema reorg.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.withSchema('trade').createTable('planogram_skus', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('product_id').notNullable();
    table.string('sku', 20).notNullable();

    table.integer('orden_exhibicion');
    table.string('categoria_exhibicion', 100);
    table.jsonb('posicion_shelf');
    table.date('vigente_desde');
    table.date('vigente_hasta');

    // audit (mismo patrón que el resto de trade.*)
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'sku'], {
      indexName: 'trade_planogram_skus_tenant_sku_unique',
    });
    table.unique(['tenant_id', 'product_id'], {
      indexName: 'trade_planogram_skus_tenant_product_unique',
    });
    table.index('tenant_id', 'idx_trade_planogram_skus_tenant');
    table.index(['tenant_id', 'orden_exhibicion'], 'idx_trade_planogram_skus_orden');
  });

  // activo GENERATED desde deleted_at (mismo patrón que el resto del proyecto)
  await knex.raw(`
    ALTER TABLE trade.planogram_skus
      ADD COLUMN activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED
  `);

  // FKs cross-schema
  await knex.raw(`
    ALTER TABLE trade.planogram_skus
      ADD CONSTRAINT fk_trade_planogram_skus_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE trade.planogram_skus
      ADD CONSTRAINT fk_trade_planogram_skus_product
      FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE trade.planogram_skus
      ADD CONSTRAINT fk_trade_planogram_skus_created_by
      FOREIGN KEY (created_by) REFERENCES identity.users(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE trade.planogram_skus
      ADD CONSTRAINT fk_trade_planogram_skus_updated_by
      FOREIGN KEY (updated_by) REFERENCES identity.users(id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE trade.planogram_skus
      ADD CONSTRAINT fk_trade_planogram_skus_deleted_by
      FOREIGN KEY (deleted_by) REFERENCES identity.users(id) ON DELETE SET NULL
  `);

  // RLS forzada
  await knex.raw(`ALTER TABLE trade.planogram_skus ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE trade.planogram_skus FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON trade.planogram_skus
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);

  // Trigger auto_populate_tenant_id (función ya existe — creada en 20260527180000)
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON trade.planogram_skus;
    CREATE TRIGGER trg_auto_populate_tenant_id
      BEFORE INSERT ON trade.planogram_skus
      FOR EACH ROW
      EXECUTE FUNCTION public.auto_populate_tenant_id();
  `);

  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON trade.planogram_skus TO app_runtime`,
  );

  await knex.raw(`
    COMMENT ON TABLE trade.planogram_skus IS
      'Subset curado de catalog.products que conforma el planograma de auditoría '
      'PdV. 1 row por (tenant_id, sku). FK a catalog.products. Metadata propia '
      'de planograma (orden, categoría exhibición, posición shelf, vigencia).'
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('trade').dropTableIfExists('planogram_skus');
};
