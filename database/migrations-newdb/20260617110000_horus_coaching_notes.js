/**
 * Horus — H2.6: ejecutor real (parte 1). commercial.coaching_notes.
 *
 * Al APROBAR una acción de coaching del co-piloto se crea aquí una nota CONCRETA y
 * persistente, dirigida al colaborador (efecto in-app real, reversible). El push
 * externo (notificación al teléfono) queda diferido hasta que el canal exista.
 *
 * collaborator_id / supervisor_id son uuid SIN FK a users (public.users es vista
 * passthrough) — mismo patrón que supervisor_actions.subject_id/approved_by.
 *
 * RLS forzado + grant app_runtime (la app del colaborador la lee vía app_runtime
 * bajo SET LOCAL app.tenant_id). Horus escribe vía KNEX_CONNECTION + tenant explícito.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('coaching_notes');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('coaching_notes', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('collaborator_id').notNullable(); // destinatario
    t.uuid('supervisor_id'); // quien aprobó la acción
    t.uuid('action_id'); // origen co-piloto (nullable)
    t.uuid('finding_id'); // problema origen (nullable)
    t.string('category', 30).notNullable().defaultTo('general'); // score | execution | photo | recognition | general
    t.text('message').notNullable();
    t.string('status', 20).notNullable().defaultTo('open'); // open | acknowledged | done
    t.timestamp('acknowledged_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by');
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('deleted_at');

    t.primary('id');
    t.index(['tenant_id', 'collaborator_id', 'status'], 'idx_coaching_notes_collab');
    t.index(['tenant_id', 'created_at'], 'idx_coaching_notes_created');
  });

  await knex.raw(`
    ALTER TABLE commercial.coaching_notes
      ADD CONSTRAINT chk_coaching_notes_status CHECK (status IN ('open', 'acknowledged', 'done'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.coaching_notes
      ADD CONSTRAINT fk_coaching_notes_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.coaching_notes ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.coaching_notes FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.coaching_notes
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.coaching_notes TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.coaching_notes IS 'Horus H2.6: nota de coaching creada al aprobar una acción del co-piloto. Efecto in-app real (visible al colaborador), reversible. Push externo diferido (ADR-020).'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('coaching_notes');
};
