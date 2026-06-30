/**
 * TC.2 (ADR-026) — Bitácora de Thot Chat. Auditable: cada pregunta/respuesta del
 * chat analítico con las tools que se invocaron. El endpoint es stateless (el
 * cliente manda el historial); esta tabla es solo registro append-only.
 *
 * RLS forzado + tenant_id. Append-only (GRANT SELECT/INSERT). Aditiva, idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_chat_log'))) {
    await knex.schema.withSchema('commercial').createTable('thot_chat_log', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('user_id');
      t.string('user_name');
      t.text('question').notNullable();
      t.text('answer');
      t.jsonb('tools_used').notNullable().defaultTo('[]');
      t.integer('iterations').defaultTo(0);
      t.string('source', 20); // llm | no_api_key | error
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'id']);
      t.index(['tenant_id', 'created_at'], 'idx_commercial_thot_chat_log_recent');
    });
    await knex.raw(`ALTER TABLE commercial.thot_chat_log ADD CONSTRAINT fk_thot_chat_log_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.thot_chat_log ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.thot_chat_log FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.thot_chat_log`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.thot_chat_log USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT ON commercial.thot_chat_log TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.thot_chat_log IS 'TC.2/ADR-026 bitacora de Thot Chat (analitica conversacional). Append-only, auditable.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('thot_chat_log');
};
