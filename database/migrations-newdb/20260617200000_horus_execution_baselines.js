/**
 * Horus — Aprendizaje L1: baselines por sujeto. commercial.execution_baselines.
 *
 * Aprende lo "normal" de cada sujeto desde el histórico (execution_360_snapshots):
 * media + desviación rodante por (sujeto, ventana, métrica). Formato LONG (1 row por
 * métrica) → maneja nulls por métrica y alimenta el z-score del motor + el panel L7.
 *
 * Convierte el umbral GLOBAL en EXPECTATIVA PROPIA: el motor detecta la tienda que
 * cae de 90→75 (invisible al umbral global) e ignora la que siempre fue 60 (falso
 * positivo hoy). `floor_met` = n_obs >= piso (~1 semana de snapshots); por debajo del
 * piso el motor cae al default global (cold-start honesto).
 *
 * Patrón Horus: idempotente (hasTable), RLS forzado + grant app_runtime, FK
 * identity.tenants, acceso runtime vía KNEX_CONNECTION + tenant_id explícito.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('execution_baselines');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('execution_baselines', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('subject_type', 20).notNullable(); // collaborator | store
    t.uuid('subject_id').notNullable();
    t.integer('window_days').notNullable();
    t.string('metric', 40).notNullable(); // avg_score | exec_score | exec_level_score | own_share_pct | photo_coverage_pct
    t.decimal('mean', 7, 2);
    t.decimal('stddev', 7, 2);
    t.integer('n_obs').notNullable().defaultTo(0); // # de snapshots (días) que sustentan el baseline
    t.decimal('min_val', 7, 2);
    t.decimal('max_val', 7, 2);
    t.boolean('floor_met').notNullable().defaultTo(false); // n_obs >= MIN_OBS_BASELINE
    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'subject_type', 'subject_id', 'window_days', 'metric'], {
      indexName: 'uq_exec_baselines',
    });
    t.index(['tenant_id', 'subject_type', 'subject_id', 'window_days'], 'idx_exec_baselines_subject');
  });

  await knex.raw(`
    ALTER TABLE commercial.execution_baselines
      ADD CONSTRAINT fk_exec_baselines_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.execution_baselines ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.execution_baselines FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.execution_baselines
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.execution_baselines TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.execution_baselines IS 'Horus Aprendizaje L1: lo "normal" por sujeto (media/desviación rodante desde execution_360_snapshots, formato long por métrica). El motor lo usa para z-score (expectativa propia vs umbral global). floor_met = piso de observaciones. ADR-021.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('execution_baselines');
};
