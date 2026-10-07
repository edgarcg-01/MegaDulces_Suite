/**
 * V.4 Modo Vendedor v2 — check-in de visitas en campo.
 *
 * commercial.vendor_visits: cada fila = un check-in explícito del vendedor a un
 * cliente. La cobertura del día se calcula contando los check-ins de hoy (TZ MX)
 * contra la cartera del vendedor. latitude/longitude quedan nullable para un
 * futuro geo-check-in (no se capturan todavía en V.4).
 *
 * FK a identity.users / identity.tenants (tablas reales; public.* son vistas) y
 * a commercial.customers vía (tenant_id, id). RLS forzado + grants app_runtime.
 * Idempotente. Aplica a local Y prod via el flujo normal de migrate (deploy).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('vendor_visits');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('vendor_visits', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('user_id').notNullable(); // vendedor que hace el check-in
    table.uuid('customer_id').notNullable();
    table.timestamp('visited_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('notes');
    table.decimal('latitude', 9, 6);
    table.decimal('longitude', 9, 6);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary('id');
    table.index(['tenant_id', 'user_id', 'visited_at'], 'idx_vendor_visits_user_date');
    table.index(['tenant_id', 'customer_id'], 'idx_vendor_visits_customer');
  });

  await knex.raw(`
    ALTER TABLE commercial.vendor_visits
      ADD CONSTRAINT fk_vendor_visits_user
      FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE commercial.vendor_visits
      ADD CONSTRAINT fk_vendor_visits_customer
      FOREIGN KEY (tenant_id, customer_id) REFERENCES commercial.customers(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE commercial.vendor_visits
      ADD CONSTRAINT fk_vendor_visits_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`ALTER TABLE commercial.vendor_visits ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.vendor_visits FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.vendor_visits
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.vendor_visits TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('vendor_visits');
};
