/**
 * Memoria persistente de Thot (admin). Notas/hechos que el usuario le ENSEÑA al
 * agente en el chat (ej. "Candelares Salgado es vendedora vecinal") para que Thot
 * los RECUERDE entre sesiones — hoy olvida todo al cerrar. Espejo del
 * tomar_nota/guardar_conocimiento de Maat (finance.knowledge), acotado a commercial
 * y al perfil admin.
 *
 * RLS forzado + tenant_id (patrón de commercial.thot_chat_log). UNIQUE(tenant_id,
 * title) → upsert idempotente. Aditiva, idempotente (hasTable). NO toca tablas existentes.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('thot_notes'))) {
    await knex.schema.withSchema('commercial').createTable('thot_notes', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('title').notNullable(); // clave corta del hecho
      t.text('body').notNullable(); // el hecho, en texto
      t.string('created_by'); // username que lo enseñó
      t.boolean('pinned').notNullable().defaultTo(false);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'id']);
      t.unique(['tenant_id', 'title']); // upsert idempotente por título
      t.index(['tenant_id', 'updated_at'], 'idx_commercial_thot_notes_recent');
    });
    await knex.raw(`ALTER TABLE commercial.thot_notes ADD CONSTRAINT fk_thot_notes_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.thot_notes ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.thot_notes FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.thot_notes`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.thot_notes USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.thot_notes TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.thot_notes IS 'Memoria persistente de Thot (admin): hechos que el usuario le ensena en el chat, recordados entre sesiones. Espejo de finance.knowledge.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('thot_notes');
};
