/**
 * Horus — Sprint Horus.4: acciones del co-piloto.
 *
 * commercial.supervisor_actions: 1 row por acción SUGERIDA por el motor a partir
 * de un finding. Nivel de autonomía = CO-PILOTO (ADR-020): el motor PROPONE
 * (status `pending_approval`), el supervisor APRUEBA/RECHAZA con un clic. Nada
 * laboral se ejecuta solo. Reusa el patrón de estado `pending_approval` de ADR-013.
 *
 * Ejecutor v1 (al aprobar): efecto INTERNO y reversible — registra la decisión en
 * `result` y confirma el finding asociado. El efecto externo (push al colaborador,
 * reasignar ruta en daily_assignments) queda DIFERIDO y documentado en `result`
 * hasta que el canal/flujo exista (push está cableado pero sin usar).
 *
 * dedup_key = action_type:subject_type:subject_id:finding_type → 1 acción viva por
 * (tipo de acción, sujeto, tipo de problema). UPSERT respeta decisiones humanas
 * (approved/rejected/executed NO se pisan al re-proponer).
 *
 * RLS forzado + grants app_runtime. Acceso runtime vía KNEX_CONNECTION (superuser)
 * + tenant_id explícito, como el resto de Horus.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('supervisor_actions');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('supervisor_actions', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('finding_id'); // origen (nullable: futuras acciones manuales)
    t.string('dedup_key', 200).notNullable();
    t.string('action_type', 40).notNullable(); // coaching | visit | flag_review
    t.string('subject_type', 20).notNullable(); // collaborator | route | store
    t.uuid('subject_id').notNullable();
    t.string('label', 160);
    t.string('title', 300).notNullable(); // descripción legible de la acción propuesta
    t.jsonb('payload').notNullable().defaultTo('{}'); // params de la acción
    t.string('proposed_by', 20).notNullable().defaultTo('horus');
    t.string('status', 20).notNullable().defaultTo('pending_approval'); // pending_approval|approved|rejected|executed|expired
    t.jsonb('result'); // resultado de la ejecución (qué se hizo, qué quedó diferido)
    t.uuid('approved_by');
    t.timestamp('approved_at');
    t.timestamp('executed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'dedup_key'], { indexName: 'uq_supervisor_actions_dedup' });
    t.index(['tenant_id', 'status'], 'idx_supervisor_actions_tenant_status');
    t.index(['tenant_id', 'finding_id'], 'idx_supervisor_actions_finding');
  });

  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT chk_supervisor_actions_status
      CHECK (status IN ('pending_approval', 'approved', 'rejected', 'executed', 'expired'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT chk_supervisor_actions_type
      CHECK (action_type IN ('coaching', 'visit', 'flag_review'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT fk_supervisor_actions_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.supervisor_actions ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.supervisor_actions FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.supervisor_actions
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.supervisor_actions TO app_runtime`,
  );

  await knex.raw(
    `COMMENT ON TABLE commercial.supervisor_actions IS 'Horus co-piloto (Trade): acciones SUGERIDAS por el motor desde findings. pending_approval → el supervisor aprueba/rechaza. Ejecutor v1 interno+reversible; efecto externo diferido. Nada laboral se dispara solo (ADR-020).'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('supervisor_actions');
};
