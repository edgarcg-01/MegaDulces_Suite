/**
 * Horus — H2.5: el co-piloto deja de ser solo "1 acción por finding".
 *
 * Extiende commercial.supervisor_actions para soportar el motor de MEJORAS
 * (OpportunityEngine): además de las acciones nacidas de un problema (kind='finding'),
 * ahora hay acciones de OPORTUNIDAD (kind='opportunity') con un `rationale` legible
 * (por qué conviene) y nuevos action_type concretos.
 *
 * Idempotente: hasColumn antes de addColumn; DROP/ADD del CHECK con IF EXISTS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasCol = (c) => knex.schema.withSchema('commercial').hasColumn('supervisor_actions', c);

  if (!(await hasCol('kind'))) {
    await knex.schema.withSchema('commercial').alterTable('supervisor_actions', (t) => {
      t.string('kind', 20).notNullable().defaultTo('finding'); // finding | opportunity
      t.text('rationale'); // por qué conviene (legible) — sobre todo para opportunities
    });
  }

  // Ampliar el set de action_type permitidos (antes: coaching | visit | flag_review).
  await knex.raw(`ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_type`);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT chk_supervisor_actions_type
      CHECK (action_type IN (
        'coaching', 'visit', 'flag_review',
        'coaching_focus', 'recover_shelf', 'reprioritize_route', 'replicate_best',
        'schedule_visit', 'flag_recapture', 'set_target'
      ))
  `);

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_supervisor_actions_tenant_kind ON commercial.supervisor_actions (tenant_id, kind, status)`,
  );
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_supervisor_actions_tenant_kind`);
  await knex.raw(`ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_type`);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT chk_supervisor_actions_type
      CHECK (action_type IN ('coaching', 'visit', 'flag_review'))
  `);
  if (await knex.schema.withSchema('commercial').hasColumn('supervisor_actions', 'kind')) {
    await knex.schema.withSchema('commercial').alterTable('supervisor_actions', (t) => {
      t.dropColumn('kind');
      t.dropColumn('rationale');
    });
  }
};
