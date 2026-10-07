/**
 * TC.4a (ADR-026) — Biblioteca de ejemplos verificados de Thot Chat ("verified
 * queries" estilo Snowflake / few-shot de Uber QueryGPT). Cada fila es un ejemplo
 * dorado: pregunta → tools correctas → respuesta modelo. Se inyectan como few-shot
 * según similitud con la pregunta nueva. NO cambia el modelo (cambia el contexto).
 *
 * Se nutre de la curaduría manual y de promover filas buenas desde thot_chat_log.
 * RLS forzado + tenant_id. Aditiva, idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_chat_examples'))) {
    await knex.schema.withSchema('commercial').createTable('thot_chat_examples', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('profile', 12).notNullable().defaultTo('admin'); // admin | portal | vendor
      t.text('question').notNullable();
      t.text('answer'); // respuesta modelo (gold)
      t.jsonb('tools').notNullable().defaultTo('[]'); // [{name, input?}]
      t.text('note'); // por qué es buen ejemplo / corrección
      t.boolean('enabled').notNullable().defaultTo(true);
      t.uuid('created_by');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'id']);
      t.index(['tenant_id', 'profile', 'enabled'], 'idx_commercial_thot_examples_profile');
    });
    await knex.raw(`ALTER TABLE commercial.thot_chat_examples ADD CONSTRAINT fk_thot_examples_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.thot_chat_examples ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.thot_chat_examples FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.thot_chat_examples`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.thot_chat_examples USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.thot_chat_examples TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.thot_chat_examples IS 'TC.4a/ADR-026 ejemplos verificados (few-shot) de Thot Chat. Pregunta->tools->respuesta gold.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('thot_chat_examples');
};
