/**
 * Migración: logistics.sequences — counter atómico genérico por (tenant, prefix, year).
 *
 * Genera folios secuenciales para shipments (EMB-YYYY-NNNNN) y delivery_guides
 * (GUIA-YYYY-NNNNN) usando el mismo patrón UPSERT que commercial.order_sequences.
 *
 *   INSERT INTO logistics.sequences (tenant_id, prefix, year, current_value)
 *   VALUES (X, 'EMB', 2026, 1)
 *   ON CONFLICT (tenant_id, prefix, year) DO UPDATE
 *     SET current_value = logistics.sequences.current_value + 1,
 *         updated_at = now()
 *   RETURNING current_value;
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.withSchema('logistics').createTable('sequences', (table) => {
    table.uuid('tenant_id').notNullable();
    table.string('prefix', 20).notNullable(); // EMB | GUIA | etc.
    table.integer('year').notNullable();
    table.integer('current_value').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.primary(['tenant_id', 'prefix', 'year']);
    table.check('?? > 0', ['year'], 'logistics_sequences_year_positive');
    table.check('?? >= 0', ['current_value'], 'logistics_sequences_current_nonneg');
  });

  await knex.raw(`
    ALTER TABLE logistics.sequences
      ADD CONSTRAINT fk_logistics_sequences_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE logistics.sequences ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE logistics.sequences FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON logistics.sequences
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.sequences TO app_runtime');

  await knex.raw(`COMMENT ON TABLE logistics.sequences IS 'Counter atómico por (tenant, prefix, year). UPSERT genera folios EMB-YYYY-NNNNN y GUIA-YYYY-NNNNN.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('sequences');
};
