/**
 * V.0 Modo Vendedor v2 — fundación: cartera del vendedor + orden de visita.
 *
 *  1. commercial.vendor_sales_routes: qué rutas de venta (sales_route) cubre cada
 *     vendedor. El rol supervisor_ventas asigna. La CARTERA del vendedor = los
 *     clientes cuya customers.sales_route esté en sus rutas. N rutas por vendedor.
 *  2. commercial.customers.visit_sequence: orden de visita del cliente dentro de su
 *     sales_route (secuencia fina). NULL = sin orden (cae al final del recorrido).
 *
 * FK a identity.users / identity.tenants (las tablas REALES; public.users/tenants
 * son vistas passthrough y no admiten FK). RLS forzado + grants app_runtime.
 * Idempotente. Aplica a local Y prod via el flujo normal de migrate (deploy).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('vendor_sales_routes');
  if (!exists) {
    await knex.schema.withSchema('commercial').createTable('vendor_sales_routes', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('user_id').notNullable(); // vendedor
      table.string('sales_route', 50).notNullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('created_by');
      table.primary('id');
      table.unique(['tenant_id', 'user_id', 'sales_route'], { indexName: 'uq_vendor_sales_routes' });
      table.index(['tenant_id', 'user_id'], 'idx_vendor_sales_routes_user');
      table.index(['tenant_id', 'sales_route'], 'idx_vendor_sales_routes_route');
    });
    await knex.raw(`
      ALTER TABLE commercial.vendor_sales_routes
        ADD CONSTRAINT fk_vendor_sales_routes_user
        FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users(tenant_id, id) ON DELETE CASCADE
    `);
    await knex.raw(`
      ALTER TABLE commercial.vendor_sales_routes
        ADD CONSTRAINT fk_vendor_sales_routes_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`ALTER TABLE commercial.vendor_sales_routes ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.vendor_sales_routes FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.vendor_sales_routes
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.vendor_sales_routes TO app_runtime`);
  }

  await knex.raw('ALTER TABLE commercial.customers ADD COLUMN IF NOT EXISTS visit_sequence integer');
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commercial_customers_visit_seq
      ON commercial.customers (tenant_id, sales_route, visit_sequence)
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS commercial.idx_commercial_customers_visit_seq');
  await knex.raw('ALTER TABLE commercial.customers DROP COLUMN IF EXISTS visit_sequence');
  await knex.schema.withSchema('commercial').dropTableIfExists('vendor_sales_routes');
};
