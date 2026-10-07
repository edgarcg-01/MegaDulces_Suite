/**
 * Fase PA.0 — pasillos 2D + dimensión de pasillo en el conteo. Ver ADR-024 /
 * FASES/FASE_PASILLOS_EQUIPOS.md.
 *
 *   commercial.warehouse_aisles            LAYOUT permanente (grilla 2D + SKUs).
 *   commercial.stock.aisle_id              mapeo SKU→pasillo (grano warehouse×product).
 *   commercial.inventory_count_assignments.aisle_id  TABLERO por folio (sup/contadores por pasillo).
 *   commercial.inventory_count_items.aisle_id        foto al abrir → particiona el conteo.
 *
 * FK de aisle_id = columna simple a warehouse_aisles.id (PK) para permitir ON DELETE
 * SET NULL (un FK compuesto con tenant_id NOT NULL no puede nullear). RLS sostiene
 * el aislamiento. Aditivo + idempotente (guards). El order flow ignora aisle_id.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1. warehouse_aisles (layout permanente)
  if (!(await knex.schema.withSchema('commercial').hasTable('warehouse_aisles'))) {
    await knex.schema.withSchema('commercial').createTable('warehouse_aisles', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('warehouse_id').notNullable();
      t.string('code', 40).notNullable();
      t.string('name', 120);
      t.integer('grid_row').notNullable().defaultTo(0);
      t.integer('grid_col').notNullable().defaultTo(0);
      t.integer('span_rows').notNullable().defaultTo(1);
      t.integer('span_cols').notNullable().defaultTo(1);
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id', 'warehouse_id', 'code'], { indexName: 'commercial_warehouse_aisles_code_unique' });
      t.index(['tenant_id', 'warehouse_id'], 'idx_commercial_warehouse_aisles_wh');
    });
    await knex.raw(`ALTER TABLE commercial.warehouse_aisles ADD CONSTRAINT fk_wh_aisles_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.warehouse_aisles ADD CONSTRAINT fk_wh_aisles_warehouse FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE commercial.warehouse_aisles ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.warehouse_aisles FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.warehouse_aisles`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.warehouse_aisles USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.warehouse_aisles TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.warehouse_aisles IS 'Pasillos 2D del almacén (layout permanente, grilla). FASE_PASILLOS_EQUIPOS / ADR-024. Los SKUs se mapean via commercial.stock.aisle_id.'`);
  }

  // 2. stock.aisle_id (mapeo SKU→pasillo)
  if (!(await knex.schema.withSchema('commercial').hasColumn('stock', 'aisle_id'))) {
    await knex.schema.withSchema('commercial').alterTable('stock', (t) => t.uuid('aisle_id'));
    await knex.raw(`ALTER TABLE commercial.stock ADD CONSTRAINT fk_stock_aisle FOREIGN KEY (aisle_id) REFERENCES commercial.warehouse_aisles(id) ON DELETE SET NULL`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_commercial_stock_aisle ON commercial.stock (tenant_id, aisle_id)`);
  }

  // 3. inventory_count_assignments.aisle_id + unique con dimensión pasillo
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_count_assignments', 'aisle_id'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_assignments', (t) => t.uuid('aisle_id'));
    await knex.raw(`ALTER TABLE commercial.inventory_count_assignments ADD CONSTRAINT fk_inv_assign_aisle FOREIGN KEY (aisle_id) REFERENCES commercial.warehouse_aisles(id) ON DELETE SET NULL`);
    // El unique viejo (tenant,count,user,role) impide al mismo supervisor cubrir 2 pasillos.
    await knex.raw(`ALTER TABLE commercial.inventory_count_assignments DROP CONSTRAINT IF EXISTS commercial_inv_assign_unique`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS commercial_inv_assign_unique ON commercial.inventory_count_assignments (tenant_id, count_id, aisle_id, user_id, assignment_role) NULLS NOT DISTINCT`);
  }

  // 4. inventory_count_items.aisle_id (foto al abrir → particiona el conteo)
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_count_items', 'aisle_id'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => t.uuid('aisle_id'));
    await knex.raw(`ALTER TABLE commercial.inventory_count_items ADD CONSTRAINT fk_inv_items_aisle FOREIGN KEY (aisle_id) REFERENCES commercial.warehouse_aisles(id) ON DELETE SET NULL`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_commercial_inv_items_aisle ON commercial.inventory_count_items (tenant_id, count_id, aisle_id)`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_count_items', 'aisle_id'))
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => t.dropColumn('aisle_id'));
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_count_assignments', 'aisle_id')) {
    await knex.raw(`DROP INDEX IF EXISTS commercial.commercial_inv_assign_unique`);
    await knex.schema.withSchema('commercial').alterTable('inventory_count_assignments', (t) => t.dropColumn('aisle_id'));
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS commercial_inv_assign_unique ON commercial.inventory_count_assignments (tenant_id, count_id, user_id, assignment_role)`);
  }
  if (await knex.schema.withSchema('commercial').hasColumn('stock', 'aisle_id'))
    await knex.schema.withSchema('commercial').alterTable('stock', (t) => t.dropColumn('aisle_id'));
  await knex.schema.withSchema('commercial').dropTableIfExists('warehouse_aisles');
};
