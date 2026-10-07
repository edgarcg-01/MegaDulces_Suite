/**
 * Migración: commercial.order_sequences — counter atómico para generar
 * `orders.code` secuencial por (tenant, year).
 *
 * Patrón:
 *   INSERT INTO order_sequences (tenant_id, year, current_value)
 *   VALUES (X, 2026, 1)
 *   ON CONFLICT (tenant_id, year) DO UPDATE
 *     SET current_value = order_sequences.current_value + 1,
 *         updated_at = now()
 *   RETURNING current_value;
 *
 * Postgres garantiza atomicidad del UPSERT: dos transacciones concurrentes
 * para el mismo (tenant, year) obtendrán valores distintos secuenciales.
 *
 * Por qué no usar SEQUENCE de Postgres:
 *   - Las SEQUENCE son globales (no por tenant). Crear una por tenant requeriría
 *     DDL en runtime cada vez que se agrega un tenant.
 *   - Y no se "rebobinan" por año.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.withSchema('commercial').createTable('order_sequences', (table) => {
    table.uuid('tenant_id').notNullable();
    table.integer('year').notNullable();
    table.integer('current_value').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.primary(['tenant_id', 'year']);
    table.check('?? > 0', ['year'], 'commercial_order_sequences_year_positive');
    table.check('?? >= 0', ['current_value'], 'commercial_order_sequences_current_nonneg');
  });

  await knex.raw(`
    ALTER TABLE commercial.order_sequences
      ADD CONSTRAINT fk_commercial_order_sequences_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.order_sequences ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.order_sequences FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.order_sequences
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.order_sequences TO app_runtime');

  await knex.raw(`COMMENT ON TABLE commercial.order_sequences IS 'Counter atómico por (tenant, year) para generar orders.code. UPSERT atómico via ON CONFLICT.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('order_sequences');
};
