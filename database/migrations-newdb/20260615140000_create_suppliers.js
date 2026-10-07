/**
 * catalog.suppliers + catalog.products.supplier_id.
 *
 * El category_id de products es inconsistente (a veces proveedor real, a veces
 * un depto genérico). Kepler tiene el proveedor real por producto (kdii.c3 →
 * kdig). Modelamos proveedores en su propia tabla y enlazamos products vía
 * supplier_id. NO se toca category_id (usado en thot/pricing/analytics) — queda
 * deprecado; la taxonomía real ya vive en department/product_line.
 *
 * FK products→suppliers usa ON DELETE SET NULL (supplier_id) de PG15+ (anula
 * solo esa columna, no tenant_id NOT NULL — ver fix 20260615120000).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('catalog').hasTable('suppliers'))) {
    await knex.schema.withSchema('catalog').createTable('suppliers', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('code', 20).notNullable();
      t.string('name', 120).notNullable();
      t.boolean('activo').notNullable().defaultTo(true);
      t.integer('orden');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.timestamp('deleted_at');
      t.uuid('deleted_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'catalog_suppliers_tenant_id_composite' });
      t.unique(['tenant_id', 'code'], { indexName: 'catalog_suppliers_code_unique' });
      t.index('tenant_id', 'idx_catalog_suppliers_tenant');
    });
    await knex.raw(`ALTER TABLE catalog.suppliers ADD CONSTRAINT fk_catalog_suppliers_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE catalog.suppliers ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE catalog.suppliers FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON catalog.suppliers`);
    await knex.raw(`CREATE POLICY tenant_isolation ON catalog.suppliers USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.suppliers TO app_runtime`);
  }

  if (!(await knex.schema.withSchema('catalog').hasColumn('products', 'supplier_id'))) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => t.uuid('supplier_id'));
    await knex.raw(`ALTER TABLE catalog.products ADD CONSTRAINT fk_catalog_products_supplier FOREIGN KEY (tenant_id, supplier_id) REFERENCES catalog.suppliers(tenant_id, id) ON DELETE SET NULL (supplier_id)`);
    await knex.raw(`COMMENT ON COLUMN catalog.products.supplier_id IS 'Proveedor real (Kepler kdii.c3→kdig). category_id queda deprecado (era inconsistente).'`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('catalog').hasColumn('products', 'supplier_id')) {
    await knex.raw(`ALTER TABLE catalog.products DROP CONSTRAINT IF EXISTS fk_catalog_products_supplier`);
    await knex.schema.withSchema('catalog').alterTable('products', (t) => t.dropColumn('supplier_id'));
  }
  await knex.schema.withSchema('catalog').dropTableIfExists('suppliers');
};
