/**
 * Horus — snapshot t0 del feature store (urgente). commercial.execution_360_snapshots.
 *
 * `execution_360` es UPSERT IN-PLACE: cada corrida pisa el valor anterior → el
 * histórico se pierde irrecuperablemente cada noche. Esta tabla append-only guarda
 * 1 snapshot por sujeto×ventana POR DÍA, habilitando tendencia y atribución futura
 * (¿el coaching movió el score?). Sin esto, cada día sin snapshot es historia perdida.
 *
 * Unique (tenant, fecha, sujeto, ventana) → idempotente: re-correr el mismo día
 * actualiza (last-write-wins del día), no duplica. Idempotente (hasTable). RLS
 * forzado + grant app_runtime, igual que el resto de Horus.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('execution_360_snapshots');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('execution_360_snapshots', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.date('snapshot_date').notNullable();
    t.string('subject_type', 20).notNullable();
    t.uuid('subject_id').notNullable();
    t.integer('window_days').notNullable();
    t.string('label', 160);
    t.integer('visits_done');
    t.decimal('avg_score', 5, 2);
    t.decimal('exec_score', 5, 2);
    t.decimal('exec_level_score', 5, 2);
    t.decimal('own_share_pct', 5, 2);
    t.decimal('competitor_share_pct', 5, 2);
    t.decimal('photo_coverage_pct', 5, 2);
    t.integer('days_since_last_visit');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'snapshot_date', 'subject_type', 'subject_id', 'window_days'], { indexName: 'uq_exec360_snap' });
    t.index(['tenant_id', 'subject_type', 'subject_id', 'window_days', 'snapshot_date'], 'idx_exec360_snap_subject');
  });

  await knex.raw(`
    ALTER TABLE commercial.execution_360_snapshots
      ADD CONSTRAINT fk_exec360_snap_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.execution_360_snapshots ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.execution_360_snapshots FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.execution_360_snapshots
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.execution_360_snapshots TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.execution_360_snapshots IS 'Horus: snapshot diario append-only de execution_360 (feature store es UPSERT in-place y pisa histórico). Habilita tendencia + atribución hallazgo→resultado. 1 row/sujeto/ventana/día.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('execution_360_snapshots');
};
