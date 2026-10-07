/**
 * Migración: schema `commercial` + customers + warehouses.
 *
 * Pivot 2026-05-26: Kepler ERP no existe. Construimos el core comercial
 * desde cero en este schema. Cuando aparezca un ERP externo se integra
 * mediante FDW o sync nocturno hacia estas mismas tablas.
 *
 * Tablas:
 *   1. commercial.customers   — clientes B2B (tiendas que compran)
 *   2. commercial.warehouses  — almacenes propios del tenant
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS commercial');
  await knex.raw('GRANT USAGE ON SCHEMA commercial TO app_runtime');
  await knex.raw('ALTER DEFAULT PRIVILEGES IN SCHEMA commercial GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime');

  // ─────────────────────────────────────────────────────────────────────────
  // commercial.customers — clientes B2B
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('customers', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('code', 50).notNullable();
    table.string('name', 200).notNullable();
    table.string('legal_name', 200);
    table.string('rfc', 13);
    table.string('email', 200);
    table.string('phone', 50);
    table.jsonb('billing_address');
    table.jsonb('shipping_address');
    table.uuid('store_id'); // opcional: vincular a un PdV de public.stores
    table.uuid('default_price_list_id'); // FK agregada en migración pricing
    table.decimal('credit_limit', 14, 2).notNullable().defaultTo(0);
    table.decimal('balance', 14, 2).notNullable().defaultTo(0);
    table.integer('payment_terms_days').notNullable().defaultTo(0);
    table.boolean('active').notNullable().defaultTo(true);
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'code'], { indexName: 'commercial_customers_tenant_code_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_customers_tenant_id_composite' });

    table.index('tenant_id', 'idx_commercial_customers_tenant');
    table.index(['tenant_id', 'active'], 'idx_commercial_customers_tenant_active');
    table.index(['tenant_id', 'name'], 'idx_commercial_customers_tenant_name');
  });

  // FKs cross-schema (knex withSchema confunde inTable, usamos raw)
  await knex.raw(`
    ALTER TABLE commercial.customers
      ADD CONSTRAINT fk_commercial_customers_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.customers
      ADD CONSTRAINT fk_commercial_customers_tenant_store
      FOREIGN KEY (tenant_id, store_id)
      REFERENCES public.stores(tenant_id, id) ON DELETE SET NULL
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // commercial.warehouses — almacenes propios
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('warehouses', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('code', 50).notNullable();
    table.string('name', 200).notNullable();
    table.text('address');
    table.boolean('is_default').notNullable().defaultTo(false);
    table.boolean('active').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'code'], { indexName: 'commercial_warehouses_tenant_code_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_warehouses_tenant_id_composite' });

    table.index('tenant_id', 'idx_commercial_warehouses_tenant');
    table.index(['tenant_id', 'active'], 'idx_commercial_warehouses_tenant_active');
  });

  await knex.raw(`
    ALTER TABLE commercial.warehouses
      ADD CONSTRAINT fk_commercial_warehouses_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // RLS forzado + grants
  // ─────────────────────────────────────────────────────────────────────────
  for (const t of ['commercial.customers', 'commercial.warehouses']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
  }
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.customers, commercial.warehouses TO app_runtime');

  // Comments
  await knex.raw(`COMMENT ON COLUMN commercial.customers.payment_terms_days IS 'Días de crédito. 0 = contado. Para beta solo cash, este campo queda para futuro.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.customers.store_id IS 'Link opcional al PdV de public.stores (mismo lugar físico evaluado por trade marketing).'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('customers');
  await knex.schema.withSchema('commercial').dropTableIfExists('warehouses');
};
