/**
 * HIQ.1 (Fase Horus-IQ) — Historial del parte diario.
 *
 * PROBLEMA: el briefing era stateless — cada día se redactaba desde cero, sin
 * memoria ("esto que te avisé el lunes sigue igual") ni continuidad narrativa.
 * Esta tabla persiste cada parte emitido (1/día/tenant): alimenta el paquete
 * comparativo del briefing siguiente y la tool horus_briefing_history del chat.
 *
 * RLS forzado + tenant_id. UPSERT por (tenant, briefing_date). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('briefing_history'))) {
    await knex.schema.withSchema('commercial').createTable('briefing_history', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('briefing_date').notNullable();
      t.string('headline', 300);
      t.text('summary');
      t.jsonb('attention').notNullable().defaultTo('[]');
      t.jsonb('stats').notNullable().defaultTo('{}');
      t.jsonb('comparison').notNullable().defaultTo('{}'); // paquete comparativo determinista (vs ayer/semana)
      t.string('source', 10); // agent | engine
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      t.primary(['tenant_id', 'id']);
      t.unique(['tenant_id', 'briefing_date'], { indexName: 'uq_commercial_briefing_history_day' });
    });
    await knex.raw(`ALTER TABLE commercial.briefing_history ADD CONSTRAINT fk_briefing_history_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE commercial.briefing_history ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.briefing_history FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.briefing_history`);
    await knex.raw(`CREATE POLICY tenant_isolation ON commercial.briefing_history USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.briefing_history TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.briefing_history IS 'HIQ.1 historial del parte diario de Horus (memoria narrativa, 1 fila por dia).'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('briefing_history');
};
