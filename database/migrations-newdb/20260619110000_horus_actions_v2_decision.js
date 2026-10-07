/**
 * Horus — Track Razonamiento (Horus.R), Sprint R2: decisión con confianza + impacto.
 *
 * Extiende commercial.supervisor_actions para que cada acción del co-piloto cargue su
 * METADATA DE DECISIÓN (determinista, auditable):
 *   - confidence      0..1 — cuánto confía Horus en la recomendación = precisión histórica
 *                     de la regla (L2) × corroboración del diagnóstico (R1).
 *   - priority        severidad × confianza × impacto → ordena la bandeja por leverage.
 *   - expected_impact {metric, baseline_mean, basis} | null — el "techo" si la acción
 *                     funciona (volver a su normal, L1). null cuando no hay baseline (honesto).
 *   - diagnosis_id    R1: el diagnóstico de causa raíz que originó la acción (sin FK, como
 *                     finding_id; el diagnóstico cambia de status, no se borra).
 *   - root_cause      copia del root_cause del diagnóstico (display sin join).
 *
 * + action_type 'escalate' para los diagnósticos de equipo/zona (team_sustained_decline).
 *
 * Invariante (ADR-016/021): el motor decide y PONDERA con números explicables; el LLM
 * sigue fuera del lazo. La confianza viene del aprendizaje (L2), no de un modelo.
 *
 * Idempotente: hasColumn antes de addColumn; DROP/ADD del CHECK con IF EXISTS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasCol = (c) => knex.schema.withSchema('commercial').hasColumn('supervisor_actions', c);

  if (!(await hasCol('confidence'))) {
    await knex.schema.withSchema('commercial').alterTable('supervisor_actions', (t) => {
      t.decimal('confidence', 4, 3); // 0..1 (L2 × corroboración R1)
      t.decimal('priority', 6, 3); // severidad × confianza × impacto
      t.jsonb('expected_impact'); // {metric, baseline_mean, basis} | null
      t.uuid('diagnosis_id'); // R1: diagnóstico de origen (sin FK, como finding_id)
      t.string('root_cause', 40); // copia del root_cause (display)
    });
  }

  // Ampliar action_type: 'escalate' para diagnósticos de equipo/zona.
  await knex.raw(`ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_type`);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT chk_supervisor_actions_type
      CHECK (action_type IN (
        'coaching', 'visit', 'flag_review',
        'coaching_focus', 'recover_shelf', 'reprioritize_route', 'replicate_best',
        'schedule_visit', 'flag_recapture', 'set_target', 'escalate'
      ))
  `);

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_supervisor_actions_priority ON commercial.supervisor_actions (tenant_id, status, priority DESC)`,
  );
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_supervisor_actions_priority`);
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
  if (await knex.schema.withSchema('commercial').hasColumn('supervisor_actions', 'confidence')) {
    await knex.schema.withSchema('commercial').alterTable('supervisor_actions', (t) => {
      t.dropColumn('confidence');
      t.dropColumn('priority');
      t.dropColumn('expected_impact');
      t.dropColumn('diagnosis_id');
      t.dropColumn('root_cause');
    });
  }
};
