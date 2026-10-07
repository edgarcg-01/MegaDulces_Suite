/**
 * HIQ.0 (Fase Horus-IQ) — Bitácora de "Pregúntale a Horus". Réplica del patrón
 * TC.2/ADR-026 (thot_chat_log) para el dominio Trade: cada pregunta/respuesta
 * del chat del supervisor con las tools invocadas + feedback 👍/👎.
 *
 * RLS forzado + tenant_id. Append-only + UPDATE solo para feedback. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('horus_chat_log'))) {
    await knex.schema.withSchema('commercial').createTable('horus_chat_log', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('user_id');
      t.string('user_name');
      t.text('question').notNullable();
      t.text('answer');
      t.jsonb('tools_used').notNullable().defaultTo('[]');
      t.integer('iterations').defaultTo(0);
      t.string('source', 20); // llm | no_api_key | error
      t.smallint('feedback'); // 1 | -1 | null
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'id']);
      t.index(['tenant_id', 'created_at'], 'idx_commercial_horus_chat_log_recent');
    });
    await knex.raw(`ALTER TABLE commercial.horus_chat_log ADD CONSTRAINT fk_horus_chat_log_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.horus_chat_log ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.horus_chat_log FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.horus_chat_log`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.horus_chat_log USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.horus_chat_log TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.horus_chat_log IS 'HIQ.0 bitacora de Pregúntale a Horus (chat del supervisor, ADR-026 sobre Trade). Append-only + feedback.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('horus_chat_log');
};
