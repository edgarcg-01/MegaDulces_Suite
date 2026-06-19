/**
 * Thot (ADR-018) — Track Aprendizaje, Sprint T.L2: calibración de reglas comerciales.
 *
 * Análogo a execution_rule_stats de Horus (L2). El PRIMER aprendizaje de Thot sobre sí
 * mismo: agrega commercial_findings.status por finding_type → precisión = confirmed /
 * (confirmed + dismissed). Cuando hay suficiente juicio humano (floor), suprime las reglas
 * que el analista descarta casi siempre y capa la severidad de las medio-ruidosas. El
 * motor de findings lo lee y deja de emitirlas; el co-piloto ajusta la confianza.
 *
 * Invariante (ADR-021): determinista, reversible (recomputa c/corrida), overridable
 * (manual_override no se pisa). Cold-start: bajo el floor NO suprime nada (cae al default).
 * Ship-collector-before-learner: la tabla existe ya; activa sola al acumular reviews.
 *
 * RLS forzado + grant app_runtime; runtime vía TenantKnexService.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('commercial_rule_stats');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('commercial_rule_stats', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('finding_type', 40).notNullable();
    t.integer('n_total').notNullable().defaultTo(0);
    t.integer('n_open').notNullable().defaultTo(0);
    t.integer('n_confirmed').notNullable().defaultTo(0);
    t.integer('n_dismissed').notNullable().defaultTo(0);
    t.integer('n_resolved').notNullable().defaultTo(0);
    t.integer('reviewed_total').notNullable().defaultTo(0);
    t.decimal('precision', 6, 4); // null hasta tener juicios
    t.boolean('floor_met').notNullable().defaultTo(false);
    t.boolean('auto_suppressed').notNullable().defaultTo(false);
    t.string('severity_cap', 10); // null | 'warn'
    t.string('manual_override', 12); // null | 'enabled' | 'suppressed' (pin humano)
    t.decimal('weight', 5, 3).notNullable().defaultTo(1.0);
    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'finding_type'], { indexName: 'uq_commercial_rule_stats' });
  });

  await knex.raw(`
    ALTER TABLE commercial.commercial_rule_stats
      ADD CONSTRAINT fk_commercial_rule_stats_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.commercial_rule_stats ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.commercial_rule_stats FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.commercial_rule_stats
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.commercial_rule_stats TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.commercial_rule_stats IS 'Thot T.L2: calibración aprendida por finding_type (precisión desde confirm/dismiss humano). Suprime/capa reglas ruidosas + ajusta confianza del co-piloto. Análogo a execution_rule_stats de Horus. manual_override = pin humano.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('commercial_rule_stats');
};
