/**
 * Horus — Aprendizaje L2: auto-calibración de reglas. commercial.execution_rule_stats.
 *
 * Primer aprendizaje REAL de Horus: aprende sobre sí mismo. 1 row por (tenant,
 * finding_type, source). El learner (RuleCalibrationService) agrega
 * supervisor_findings.status → precision = confirmed / (confirmed + dismissed) y,
 * cuando hay suficiente juicio humano (floor), decide auto_suppressed / severity_cap.
 * El FindingsEngine lee esta tabla y deja de emitir (o capa) las reglas ruidosas.
 *
 * manual_override = pin humano (L7); el learner NUNCA lo pisa (no va en el merge).
 * Determinista + auditable + reversible (recomputa cada corrida). El humano no pierde
 * control (ADR-021). Idempotente (hasTable). RLS forzado + grant app_runtime (patrón
 * Horus: acceso runtime vía KNEX_CONNECTION + tenant_id explícito).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('execution_rule_stats');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('execution_rule_stats', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('finding_type', 40).notNullable();
    t.string('source', 20).notNullable().defaultTo('engine'); // engine | vision | embedding | fraud
    t.integer('n_total').notNullable().defaultTo(0);
    t.integer('n_open').notNullable().defaultTo(0);
    t.integer('n_confirmed').notNullable().defaultTo(0);
    t.integer('n_dismissed').notNullable().defaultTo(0);
    t.integer('n_reviewed').notNullable().defaultTo(0);
    t.integer('n_resolved').notNullable().defaultTo(0);
    t.integer('reviewed_total').notNullable().defaultTo(0); // confirmed + dismissed (denominador "juzgado")
    t.decimal('precision', 5, 4); // confirmed / reviewed_total; null si denom 0
    t.boolean('floor_met').notNullable().defaultTo(false); // reviewed_total >= MIN_REVIEWED
    t.boolean('auto_suppressed').notNullable().defaultTo(false);
    t.string('severity_cap', 10); // null | 'warn' (capa critical→warn cuando es media-ruidosa)
    t.string('manual_override', 12); // null | 'enabled' | 'suppressed' (pin humano, L7)
    t.decimal('weight', 4, 3).notNullable().defaultTo(1.0); // multiplicador de prioridad (panel/orden)
    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'finding_type', 'source'], { indexName: 'uq_exec_rule_stats' });
    t.index(['tenant_id'], 'idx_exec_rule_stats_tenant');
  });

  await knex.raw(`
    ALTER TABLE commercial.execution_rule_stats
      ADD CONSTRAINT fk_exec_rule_stats_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.execution_rule_stats ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.execution_rule_stats FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.execution_rule_stats
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.execution_rule_stats TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.execution_rule_stats IS 'Horus Aprendizaje L2: precisión por regla (finding_type×source) desde supervisor_findings.status. El motor suprime/capa reglas ruidosas; manual_override = pin humano. Determinista, reversible, auditable (ADR-021).'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('execution_rule_stats');
};
