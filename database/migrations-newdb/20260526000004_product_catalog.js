/**
 * Migración: catálogo de productos (brands + products).
 *
 * En legacy estas tablas se llamaban planograma_marcas y planograma_productos
 * pero fueron renombradas a brands/products en migración v4. En la nueva DB
 * se mantiene el naming en inglés desde el origen.
 *
 * Convenciones del proyecto multi-tenant:
 *   - tenant_id UUID NOT NULL
 *   - Audit fields completos
 *   - Composite FK (tenant_id, brand_id) → brands(tenant_id, id) garantiza
 *     que un producto no puede referenciar una brand de otro tenant
 *   - RLS tenant_isolation con WITH CHECK
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // BRANDS — marcas del portafolio del tenant
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('brands', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.string('nombre', 100).notNullable();
    table.boolean('activo').notNullable().defaultTo(true);
    table.integer('orden').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'nombre'], { indexName: 'brands_tenant_nombre_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'brands_tenant_id_composite' });
    table.index('tenant_id', 'idx_brands_tenant');
    table.index(['tenant_id', 'activo'], 'idx_brands_tenant_activo');
    table.index(['tenant_id', 'orden'], 'idx_brands_tenant_orden');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PRODUCTS — SKUs/productos del portafolio. Pertenecen a una brand.
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.createTable('products', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable().references('id').inTable('tenants').onDelete('RESTRICT');
    table.uuid('brand_id').notNullable();
    table.string('nombre', 150).notNullable();
    table.boolean('activo').notNullable().defaultTo(true);
    table.integer('orden').notNullable().defaultTo(0);
    table.decimal('puntuacion', 5, 2).notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('deleted_at');
    table.uuid('deleted_by').references('id').inTable('users').onDelete('SET NULL');

    table.primary('id');
    table.unique(['tenant_id', 'brand_id', 'nombre'], { indexName: 'products_tenant_brand_nombre_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'products_tenant_id_composite' });

    // Composite FK cross-tenant safe — un producto del tenant A solo puede
    // referenciar una brand del tenant A. Sin esto, la FK simple permitiría
    // assignment cross-tenant (RLS lo detectaría en read pero no en write).
    table.foreign(['tenant_id', 'brand_id'], 'fk_products_tenant_brand')
      .references(['tenant_id', 'id']).inTable('brands').onDelete('CASCADE');

    table.index('tenant_id', 'idx_products_tenant');
    table.index(['tenant_id', 'brand_id'], 'idx_products_tenant_brand');
    table.index(['tenant_id', 'activo'], 'idx_products_tenant_activo');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RLS en ambas tablas
  // ─────────────────────────────────────────────────────────────────────────
  for (const t of ['brands', 'products']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    `);
  }

  // Default privileges no aplican retroactivamente — garantizamos grants explícitos
  // por si una conexión live no recibió el ALTER DEFAULT PRIVILEGES.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON brands, products TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE brands IS 'Marcas del portafolio del tenant. Padre de products. RLS activo.'`);
  await knex.raw(`COMMENT ON TABLE products IS 'SKUs del portafolio. Pertenecen a una brand del mismo tenant (composite FK enforce).'`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('products');
  await knex.schema.dropTableIfExists('brands');
};
