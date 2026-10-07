/**
 * Thot (ADR-018) — Track Razonamiento, Sprint T.R1: diagnóstico de causa raíz comercial.
 *
 * commercial.commercial_diagnoses: análogo a supervisor_diagnoses de Horus. Correlaciona
 * ≥2 commercial_findings co-ocurrentes del MISMO sujeto en UNA causa raíz dominante.
 * En vez de "no rota" + "margen flojo" como hallazgos sueltos, concluye "candidato a
 * liquidar (no rota y no deja)". El motor razona (determinista/auditable); el agente
 * (T.R3) redacta. summary = redacción determinista con números reales (NO LLM).
 *
 * Invariante: un diagnóstico SIEMPRE linkea ≥2 findings. El síntoma aislado queda atómico.
 * dedup_key (= subject_type:subject_id:root_cause). UPSERT idempotente; respeta
 * dismissed/confirmed. RLS forzado + grant app_runtime; runtime vía TenantKnexService.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('commercial_diagnoses');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('commercial_diagnoses', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('dedup_key', 200).notNullable();
    t.string('root_cause', 40).notNullable(); // unprofitable_deadweight | distribution_misfit | low_value_push | ...
    t.string('severity', 10).notNullable().defaultTo('warn');
    t.string('subject_type', 20).notNullable(); // product | customer
    t.uuid('subject_id').notNullable();
    t.string('label', 160);
    t.jsonb('finding_ids').notNullable().defaultTo('[]');
    t.jsonb('finding_types').notNullable().defaultTo('[]');
    t.decimal('confidence', 4, 3);
    t.text('summary');
    t.jsonb('evidence').notNullable().defaultTo('{}'); // { action_hint, corroboration, symptoms[] }
    t.string('status', 15).notNullable().defaultTo('open');
    t.uuid('reviewed_by');
    t.timestamp('reviewed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'dedup_key'], { indexName: 'uq_commercial_diagnoses_dedup' });
    t.index(['tenant_id', 'status', 'severity'], 'idx_commercial_diagnoses_tenant_status');
    t.index(['tenant_id', 'subject_type', 'subject_id'], 'idx_commercial_diagnoses_subject');
  });

  await knex.raw(`
    ALTER TABLE commercial.commercial_diagnoses
      ADD CONSTRAINT chk_commercial_diagnoses_severity CHECK (severity IN ('info', 'warn', 'critical'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.commercial_diagnoses
      ADD CONSTRAINT chk_commercial_diagnoses_status CHECK (status IN ('open', 'reviewed', 'dismissed', 'confirmed', 'resolved'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.commercial_diagnoses
      ADD CONSTRAINT chk_commercial_diagnoses_subject CHECK (subject_type IN ('product', 'customer', 'zone'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.commercial_diagnoses
      ADD CONSTRAINT fk_commercial_diagnoses_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.commercial_diagnoses ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.commercial_diagnoses FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.commercial_diagnoses
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.commercial_diagnoses TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.commercial_diagnoses IS 'Thot T.R1: diagnóstico de causa raíz comercial. Correlaciona >=2 commercial_findings del mismo sujeto en una causa dominante. Motor razona (determinista), agente comunica. UPSERT idempotente.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('commercial_diagnoses');
};
