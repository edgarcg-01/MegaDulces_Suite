/**
 * Horus — Sprint Horus.1: tabla de hallazgos del motor de supervisión.
 *
 * commercial.supervisor_findings: 1 row por hallazgo "vivo". El motor determinista
 * (FindingsEngineService) lee execution_360 + execution_thresholds y emite findings
 * (score_drop, low_score, competitor_dominance, store_at_risk). La visión (Horus.5)
 * y el detector de fraude (Horus.6) escribirán acá con source='vision'/'embedding'.
 *
 * dedup_key (= finding_type:subject_type:subject_id:window_days) hace el hallazgo
 * idempotente: UPSERT por (tenant_id, dedup_key) → un finding "vivo" por problema.
 *   - status open      → en la bandeja del supervisor
 *   - reviewed/resolved → cerrado por el sistema (resolved = la regla ya no aplica)
 *   - dismissed/confirmed → DECISIÓN HUMANA: el motor NO la pisa al recomputar
 *
 * evidence (JSONB) = los números deterministas que sustentan el hallazgo (NO texto
 * de LLM). explanation = redacción del agente (Horus.2). El LLM nunca decide la
 * existencia del finding ni acciona — solo comunica (invariante ADR-016/ADR-020).
 *
 * RLS forzado + grants app_runtime (defense-in-depth). Acceso runtime vía
 * KNEX_CONNECTION (superuser) + tenant_id explícito, como el resto de Horus.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('supervisor_findings');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('supervisor_findings', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('dedup_key', 200).notNullable();
    t.string('finding_type', 40).notNullable(); // score_drop | low_score | competitor_dominance | store_at_risk | ...
    t.string('severity', 10).notNullable().defaultTo('warn'); // info | warn | critical
    t.string('subject_type', 20).notNullable(); // collaborator | route | store
    t.uuid('subject_id').notNullable();
    t.string('label', 160); // nombre denormalizado del subject (display sin join)
    t.uuid('capture_id'); // null para findings de motor; lo usa vision/fraude por captura
    t.decimal('score', 6, 2); // magnitud/severidad numérica del hallazgo
    t.jsonb('evidence').notNullable().defaultTo('{}'); // datos deterministas que lo sustentan
    t.text('explanation'); // redacción del agente (Horus.2); null hasta entonces
    t.string('source', 20).notNullable().defaultTo('engine'); // engine | vision | embedding
    t.string('status', 15).notNullable().defaultTo('open'); // open | reviewed | dismissed | confirmed | resolved
    t.uuid('reviewed_by');
    t.timestamp('reviewed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'dedup_key'], { indexName: 'uq_supervisor_findings_dedup' });
    t.index(['tenant_id', 'status', 'severity'], 'idx_supervisor_findings_tenant_status');
    t.index(['tenant_id', 'subject_type', 'subject_id'], 'idx_supervisor_findings_subject');
  });

  await knex.raw(`
    ALTER TABLE commercial.supervisor_findings
      ADD CONSTRAINT chk_supervisor_findings_severity
      CHECK (severity IN ('info', 'warn', 'critical'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_findings
      ADD CONSTRAINT chk_supervisor_findings_status
      CHECK (status IN ('open', 'reviewed', 'dismissed', 'confirmed', 'resolved'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_findings
      ADD CONSTRAINT chk_supervisor_findings_source
      CHECK (source IN ('engine', 'vision', 'embedding'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_findings
      ADD CONSTRAINT fk_supervisor_findings_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.supervisor_findings ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.supervisor_findings FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.supervisor_findings
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.supervisor_findings TO app_runtime`,
  );

  await knex.raw(
    `COMMENT ON TABLE commercial.supervisor_findings IS 'Horus: hallazgos del motor de supervisión (Trade). UPSERT idempotente por (tenant_id, dedup_key). Motor decide, agente comunica (explanation), LLM nunca acciona. evidence = números deterministas.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('supervisor_findings');
};
