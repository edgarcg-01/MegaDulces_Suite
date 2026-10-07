/**
 * Thot (ADR-018) — Track Razonamiento, Sprint T.R2: cola de acciones del co-piloto.
 *
 * commercial.commercial_actions: análogo a supervisor_actions de Horus. El motor PROPONE
 * (status pending_approval), el humano APRUEBA/RECHAZA. Nada se dispara solo (ADR-016/020).
 * Cada acción carga su METADATA DE DECISIÓN (determinista, auditable):
 *   - confidence      0..1 — corroboración del diagnóstico (T.R1); la afinará T.L2.
 *   - expected_impact {kind, value, basis} | null — $ esperado donde el dato es limpio
 *                     (uplift de margen = brecha × precio × unidades); null si no se puede.
 *   - priority        severidad × confianza × impacto → ordena la bandeja.
 *   - diagnosis_id / root_cause: el diagnóstico que la originó (N→1).
 *
 * Ejecutor (al aprobar): efecto INTERNO reversible. push_product → crea un push_directive
 * REAL (el recomendador Thot ya lo consume → lazo cerrado). El resto (delist/precio/
 * recompra) → nota interna; el cambio sensible (catálogo/precios/WhatsApp) queda diferido.
 *
 * dedup_key idempotente; respeta approved/rejected/executed. RLS forzado; runtime vía
 * TenantKnexService.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('commercial_actions');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('commercial_actions', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('finding_id'); // origen atómico (nullable)
    t.uuid('diagnosis_id'); // origen de diagnóstico (nullable; sin FK, como finding_id)
    t.string('dedup_key', 200).notNullable();
    t.string('kind', 20).notNullable().defaultTo('finding'); // finding | diagnosis
    t.string('action_type', 40).notNullable(); // push_product | review_delist | review_price | reorder_outreach
    t.string('subject_type', 20).notNullable(); // product | customer
    t.uuid('subject_id').notNullable();
    t.string('label', 160);
    t.string('title', 300).notNullable();
    t.text('rationale');
    t.jsonb('payload').notNullable().defaultTo('{}');
    t.decimal('confidence', 4, 3);
    t.jsonb('expected_impact'); // {kind, value, basis} | null
    t.decimal('priority', 8, 3);
    t.string('root_cause', 40);
    t.string('proposed_by', 20).notNullable().defaultTo('thot');
    t.string('status', 20).notNullable().defaultTo('pending_approval'); // pending_approval|approved|rejected|executed|expired
    t.jsonb('result');
    t.uuid('approved_by');
    t.timestamp('approved_at');
    t.timestamp('executed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'dedup_key'], { indexName: 'uq_commercial_actions_dedup' });
    t.index(['tenant_id', 'status', 'priority'], 'idx_commercial_actions_tenant_status');
  });

  await knex.raw(`
    ALTER TABLE commercial.commercial_actions
      ADD CONSTRAINT chk_commercial_actions_status
      CHECK (status IN ('pending_approval', 'approved', 'rejected', 'executed', 'expired'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.commercial_actions
      ADD CONSTRAINT chk_commercial_actions_type
      CHECK (action_type IN ('push_product', 'review_delist', 'review_price', 'reorder_outreach'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.commercial_actions
      ADD CONSTRAINT fk_commercial_actions_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.commercial_actions ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.commercial_actions FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.commercial_actions
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.commercial_actions TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.commercial_actions IS 'Thot T.R2: cola de acciones del co-piloto comercial. Motor propone (confidence/impact$/priority), humano aprueba/rechaza. push_product ejecuta un push_directive real (lazo cerrado); resto = nota interna. Nada se dispara solo (ADR-020).'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('commercial_actions');
};
