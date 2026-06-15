/**
 * Fase I.6 — conteo por FASES estrictas + sesiones de jornada por contador.
 *
 * current_pass en el folio: la pasada activa (1 = primer conteo, 2 = segundo
 * conteo ciego). submitCount solo escribe en la pasada vigente; el supervisor
 * avanza de fase con un botón cuando la cobertura de la pasada llega al 100%.
 *
 * commercial.inventory_count_sessions: una fila por (folio, contador, pasada)
 * con started_at / finished_at, para que el supervisor lleve el control de su
 * personal (a qué hora empezó, a qué hora terminó, qué pasada). "Qué contó" se
 * deriva de los items (counted_by_N / counted_at_N).
 *
 * Aditivo e idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'current_pass'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => {
      t.smallint('current_pass').notNullable().defaultTo(1); // 1 | 2
    });
  }

  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_count_sessions'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_count_sessions', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('count_id').notNullable();
      t.uuid('user_id').notNullable();
      t.string('username', 80);
      t.smallint('pass').notNullable().defaultTo(1);
      t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('finished_at');
      t.string('status', 12).notNullable().defaultTo('active'); // 'active' | 'finished'
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'count_id', 'user_id', 'pass'], { indexName: 'commercial_inv_session_unique' });
      t.index(['tenant_id', 'count_id'], 'idx_commercial_inv_session_count');
    });
    await knex.raw(`ALTER TABLE commercial.inventory_count_sessions ADD CONSTRAINT fk_inv_session_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_sessions ADD CONSTRAINT fk_inv_session_count FOREIGN KEY (tenant_id, count_id) REFERENCES commercial.inventory_counts(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_sessions ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.inventory_count_sessions FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_count_sessions`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.inventory_count_sessions USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.inventory_count_sessions TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_count_sessions');
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_counts', 'current_pass')) {
    await knex.schema.withSchema('commercial').alterTable('inventory_counts', (t) => t.dropColumn('current_pass'));
  }
};
