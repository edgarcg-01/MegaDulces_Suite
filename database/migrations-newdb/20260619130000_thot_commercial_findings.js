/**
 * Thot (ADR-018) — Track Razonamiento, Sprint T.R0: motor de findings comerciales.
 *
 * commercial.commercial_findings: el análogo comercial de supervisor_findings (Horus).
 * 1 row por hallazgo "vivo". El motor determinista (CommercialFindingsService) lee
 * customer_360 + catálogo + señales intelligence.* y emite findings. CERO LLM.
 *
 * Audit T.R0 (2026-06-19): el dato cliente×tiempo casi no existe (2 clientes con
 * historia de pedidos) pero producto×zona×PdV es rico (11k productos, 48k afinidades,
 * 17k zone_demand, 1k pdv_presence). Por eso los findings ACTIVOS son de portafolio/
 * distribución (subject_type='product'); el churn de cliente (subject_type='customer')
 * queda esparcido/dormido hasta que maduren los pedidos (mismo patrón que
 * sales_execution_gap en Horus). No se diseña sobre dato que no existe.
 *
 * dedup_key (= finding_type:subject_type:subject_id) → idempotente. Respeta decisiones
 * humanas (dismissed/confirmed NO se pisan). RLS forzado + grant app_runtime; acceso
 * runtime vía TenantKnexService (RLS real, distinto a Horus que usa superuser).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('commercial_findings');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('commercial_findings', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('dedup_key', 200).notNullable();
    t.string('finding_type', 40).notNullable(); // low_rotation_priced | margin_laggard | distribution_gap | churn_risk | ...
    t.string('severity', 10).notNullable().defaultTo('warn'); // info | warn | critical
    t.string('subject_type', 20).notNullable(); // product | customer
    t.uuid('subject_id').notNullable();
    t.string('label', 160); // nombre denormalizado (producto/cliente)
    t.decimal('score', 12, 2); // magnitud/badness del hallazgo (orden)
    t.jsonb('evidence').notNullable().defaultTo('{}'); // números deterministas que lo sustentan
    t.text('explanation'); // redacción del agente (T.R3); null hasta entonces
    t.string('source', 20).notNullable().defaultTo('engine'); // engine | (futuro: ml)
    t.string('status', 15).notNullable().defaultTo('open'); // open | reviewed | dismissed | confirmed | resolved
    t.uuid('reviewed_by');
    t.timestamp('reviewed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'dedup_key'], { indexName: 'uq_commercial_findings_dedup' });
    t.index(['tenant_id', 'status', 'severity'], 'idx_commercial_findings_tenant_status');
    t.index(['tenant_id', 'subject_type', 'subject_id'], 'idx_commercial_findings_subject');
  });

  await knex.raw(`
    ALTER TABLE commercial.commercial_findings
      ADD CONSTRAINT chk_commercial_findings_severity
      CHECK (severity IN ('info', 'warn', 'critical'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.commercial_findings
      ADD CONSTRAINT chk_commercial_findings_status
      CHECK (status IN ('open', 'reviewed', 'dismissed', 'confirmed', 'resolved'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.commercial_findings
      ADD CONSTRAINT chk_commercial_findings_subject
      CHECK (subject_type IN ('product', 'customer', 'zone'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.commercial_findings
      ADD CONSTRAINT fk_commercial_findings_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.commercial_findings ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.commercial_findings FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.commercial_findings
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.commercial_findings TO app_runtime`,
  );

  await knex.raw(
    `COMMENT ON TABLE commercial.commercial_findings IS 'Thot T.R0: hallazgos del motor de inteligencia comercial (portafolio/distribución activos; churn de cliente esparcido hasta que maduren pedidos). Análogo a supervisor_findings de Horus. UPSERT idempotente (tenant_id, dedup_key). Motor decide, agente comunica.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('commercial_findings');
};
