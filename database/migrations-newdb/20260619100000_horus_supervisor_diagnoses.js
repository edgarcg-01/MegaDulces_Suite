/**
 * Horus — Track Razonamiento (Horus.R), Sprint R1: diagnóstico de causa raíz.
 *
 * commercial.supervisor_diagnoses: 1 row por DIAGNÓSTICO "vivo". Mientras
 * supervisor_findings tiene 1 síntoma por row, un diagnóstico CORRELACIONA ≥2
 * findings co-ocurrentes del MISMO sujeto en una causa raíz coherente. Es el
 * pensamiento analítico de Horus: en vez de "score bajo" + "anaquel flojo" como
 * 2 hallazgos sueltos, concluye "el score bajo se explica por ejecución floja".
 *
 * El motor DECIDE el diagnóstico con reglas explicables (DiagnosisEngineService).
 * summary = redacción determinista (NO LLM) que linkea los síntomas. evidence =
 * números que lo sustentan. finding_ids/finding_types = los síntomas que lo
 * componen (auditable). confidence = corroboración (R1) → la afina L2 (R2).
 *
 * Invariante ADR-016/020/021: el motor razona (determinista/auditable), el agente
 * solo comunica, nada laboral se dispara solo. R2 mapea diagnóstico → UNA acción
 * coherente del co-piloto (en vez de N acciones dispersas).
 *
 * dedup_key (= subject_type:subject_id:root_cause) hace el diagnóstico idempotente:
 * UPSERT por (tenant_id, dedup_key). Respeta decisiones humanas (dismissed/confirmed
 * NO se pisan al recomputar). Los 'open' que ya no aplican pasan a 'resolved'.
 *
 * RLS forzado + grants app_runtime (defense-in-depth). Acceso runtime vía
 * KNEX_CONNECTION (superuser) + tenant_id explícito, como el resto de Horus.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('supervisor_diagnoses');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('supervisor_diagnoses', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('dedup_key', 200).notNullable();
    t.string('root_cause', 40).notNullable(); // execution_quality_decline | time_management_impact | sustained_decline | store_at_risk_compound | team_sustained_decline
    t.string('severity', 10).notNullable().defaultTo('warn'); // info | warn | critical
    t.string('subject_type', 20).notNullable(); // collaborator | route | store | zone | supervisor
    t.uuid('subject_id').notNullable();
    t.string('label', 160); // nombre denormalizado del subject (display sin join)
    t.jsonb('finding_ids').notNullable().defaultTo('[]'); // UUIDs de los síntomas que lo componen
    t.jsonb('finding_types').notNullable().defaultTo('[]'); // tipos (display sin join)
    t.decimal('confidence', 4, 3); // 0..1 — corroboración (R1); la refina L2 (R2)
    t.text('summary'); // redacción determinista que linkea los síntomas (NO LLM)
    t.jsonb('evidence').notNullable().defaultTo('{}'); // números que sustentan el diagnóstico
    t.string('status', 15).notNullable().defaultTo('open'); // open | reviewed | dismissed | confirmed | resolved
    t.uuid('reviewed_by');
    t.timestamp('reviewed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'dedup_key'], { indexName: 'uq_supervisor_diagnoses_dedup' });
    t.index(['tenant_id', 'status', 'severity'], 'idx_supervisor_diagnoses_tenant_status');
    t.index(['tenant_id', 'subject_type', 'subject_id'], 'idx_supervisor_diagnoses_subject');
  });

  await knex.raw(`
    ALTER TABLE commercial.supervisor_diagnoses
      ADD CONSTRAINT chk_supervisor_diagnoses_severity
      CHECK (severity IN ('info', 'warn', 'critical'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_diagnoses
      ADD CONSTRAINT chk_supervisor_diagnoses_status
      CHECK (status IN ('open', 'reviewed', 'dismissed', 'confirmed', 'resolved'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_diagnoses
      ADD CONSTRAINT fk_supervisor_diagnoses_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.supervisor_diagnoses ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.supervisor_diagnoses FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.supervisor_diagnoses
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.supervisor_diagnoses TO app_runtime`,
  );

  await knex.raw(
    `COMMENT ON TABLE commercial.supervisor_diagnoses IS 'Horus R1: diagnóstico de causa raíz. Correlaciona >=2 findings co-ocurrentes del mismo sujeto en una causa raíz. Motor razona (determinista/auditable), agente comunica. UPSERT idempotente (tenant_id, dedup_key). summary = redacción determinista, NO LLM.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('supervisor_diagnoses');
};
