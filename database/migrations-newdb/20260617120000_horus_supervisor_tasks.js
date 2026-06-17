/**
 * Horus — H2.6: ejecutor real (parte 2). commercial.supervisor_tasks.
 *
 * Al APROBAR una acción de visita/recuperación/repriorización del co-piloto se crea
 * aquí una TAREA concreta para mañana, opcionalmente auto-asignada al colaborador
 * que atiende esa tienda/ruta (último captor). Efecto in-app real y reversible. La
 * sincronización a daily_assignments y el push externo quedan diferidos.
 *
 * store_id / route_id / assigned_to_user son uuid SIN FK (referencias best-effort a
 * tablas/vistas legacy) — mismo patrón que route_tickets.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('supervisor_tasks');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('supervisor_tasks', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('action_id'); // origen co-piloto (nullable)
    t.string('task_type', 20).notNullable(); // visit | recover | reprioritize | recapture
    t.uuid('assigned_to_user'); // colaborador (best-effort: último captor)
    t.uuid('store_id');
    t.uuid('route_id');
    t.date('due_date');
    t.string('title', 300).notNullable();
    t.jsonb('details').notNullable().defaultTo('{}');
    t.string('status', 20).notNullable().defaultTo('pending'); // pending | done | cancelled
    t.timestamp('done_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by');
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('deleted_at');

    t.primary('id');
    t.index(['tenant_id', 'status'], 'idx_supervisor_tasks_tenant_status');
    t.index(['tenant_id', 'assigned_to_user', 'status'], 'idx_supervisor_tasks_assignee');
    t.index(['tenant_id', 'created_at'], 'idx_supervisor_tasks_created');
  });

  await knex.raw(`
    ALTER TABLE commercial.supervisor_tasks
      ADD CONSTRAINT chk_supervisor_tasks_status CHECK (status IN ('pending', 'done', 'cancelled'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_tasks
      ADD CONSTRAINT chk_supervisor_tasks_type CHECK (task_type IN ('visit', 'recover', 'reprioritize', 'recapture'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_tasks
      ADD CONSTRAINT fk_supervisor_tasks_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.supervisor_tasks ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.supervisor_tasks FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.supervisor_tasks
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.supervisor_tasks TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.supervisor_tasks IS 'Horus H2.6: tarea de campo creada al aprobar una acción del co-piloto (visita/recuperación/repriorización/recaptura). Efecto in-app real, reversible. Sync a daily_assignments + push externo diferidos (ADR-020).'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('supervisor_tasks');
};
