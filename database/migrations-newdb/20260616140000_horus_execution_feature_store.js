/**
 * Horus (Supervisor AI de ejecución, Trade) — Sprint Horus.0: feature store.
 *
 * commercial.execution_360: 1 row por (tenant_id, subject_type, subject_id, window_days).
 *   Telemetría de EJECUCIÓN en campo (no de venta) — el análogo Trade de customer_360.
 *   subject_type ∈ collaborator|route|store. UPSERT por el cron nocturno + on-demand.
 *   Derivado de daily_captures + daily_assignments (NO toca dinero ni pedidos).
 *
 * commercial.execution_thresholds: 1 row por tenant. Umbrales que el motor de
 *   findings (Horus.1) usa para decidir qué es anomalía. Editables por el negocio.
 *
 * subject_id es polimórfico (user/route/store) → sin FK compuesta; solo FK a tenant.
 * RLS forzado + grants app_runtime (defense-in-depth). El acceso runtime es vía
 * KNEX_CONNECTION (superuser, bypassa RLS) + tenant_id explícito, igual que
 * CommercialMap/Reports — porque Horus lee daily_captures (misma DB, search_path).
 *
 * @param { import("knex").Knex } knex
 */
async function hardenRls(knex, table) {
  await knex.raw(`ALTER TABLE commercial.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.${table}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  const has = (t) => knex.schema.withSchema('commercial').hasTable(t);

  if (!(await has('execution_360'))) {
    await knex.schema.withSchema('commercial').createTable('execution_360', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('subject_type', 20).notNullable(); // collaborator | route | store
      t.uuid('subject_id').notNullable();
      t.integer('window_days').notNullable(); // 7 | 30 (evita la palabra reservada `window`)
      t.string('label', 160); // nombre denormalizado (username/ruta/tienda) p/display sin join

      t.integer('visits_done').notNullable().defaultTo(0);
      t.integer('visits_planned').notNullable().defaultTo(0);
      t.decimal('coverage_pct', 5, 2);
      t.decimal('avg_score', 5, 2);
      t.decimal('score_trend', 6, 2); // delta de score vs período anterior (puntos)
      t.decimal('idle_min_avg', 8, 2);
      t.decimal('own_share_pct', 5, 2);
      t.decimal('competitor_share_pct', 5, 2);
      t.decimal('photo_coverage_pct', 5, 2);
      t.integer('days_since_last_visit');
      t.integer('anomaly_count').notNullable().defaultTo(0);

      t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'subject_type', 'subject_id', 'window_days'], {
        indexName: 'uq_execution_360_subject',
      });
      t.index(['tenant_id', 'subject_type', 'window_days'], 'idx_execution_360_tenant_type');
    });
    await knex.raw(`
      ALTER TABLE commercial.execution_360
        ADD CONSTRAINT chk_execution_360_subject_type
        CHECK (subject_type IN ('collaborator', 'route', 'store'))
    `);
    await knex.raw(`
      ALTER TABLE commercial.execution_360
        ADD CONSTRAINT chk_execution_360_window
        CHECK (window_days IN (7, 30))
    `);
    await knex.raw(`
      ALTER TABLE commercial.execution_360
        ADD CONSTRAINT fk_execution_360_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await hardenRls(knex, 'execution_360');
    await knex.raw(
      `COMMENT ON TABLE commercial.execution_360 IS 'Horus feature store de ejecución en campo (Trade). 1 row UPSERT por (subject_type, subject_id, window_days). Derivado de daily_captures + daily_assignments. No toca dinero.'`,
    );
  }

  if (!(await has('execution_thresholds'))) {
    await knex.schema.withSchema('commercial').createTable('execution_thresholds', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      // Defaults calibrados con la distribución REAL (audit 2026-06-16, 136 caps/30d):
      // score mediana ~38% (p25 ~27), competencia ~63% de exhibiciones, foto ~49%.
      // Por eso el motor v1 NO emite findings de foto/cobertura/idle (serían ruido basal).
      t.decimal('score_min_pct', 5, 2).notNullable().defaultTo(25); // low_score: nivel absoluto bajo (~p25 real)
      t.decimal('score_drop_pct', 5, 2).notNullable().defaultTo(8); // score_drop: caída de score (puntos %) que dispara finding
      t.decimal('competitor_dominance_pct', 5, 2).notNullable().defaultTo(70); // competidor domina si share >= esto (basal ~63%)
      t.integer('days_no_visit_max').notNullable().defaultTo(14); // store_at_risk: días sin visita (solo tiendas con store_id)
      t.decimal('coverage_min_pct', 5, 2).notNullable().defaultTo(80); // pend. datos (daily_assignments + store_id)
      t.integer('idle_max_min').notNullable().defaultTo(120); // pend. datos (getIdleSummary)
      t.decimal('photo_min_pct', 5, 2).notNullable().defaultTo(60); // no usado en v1 (cobertura basal ~49%)
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id'], { indexName: 'uq_execution_thresholds_tenant' });
    });
    await knex.raw(`
      ALTER TABLE commercial.execution_thresholds
        ADD CONSTRAINT fk_execution_thresholds_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await hardenRls(knex, 'execution_thresholds');
    await knex.raw(
      `COMMENT ON TABLE commercial.execution_thresholds IS 'Horus: umbrales por tenant para el motor de findings (cobertura, score-drop, idle, días sin visita, dominancia competencia, fotos). Editables por el negocio.'`,
    );
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('execution_360');
  await knex.schema.withSchema('commercial').dropTableIfExists('execution_thresholds');
};
