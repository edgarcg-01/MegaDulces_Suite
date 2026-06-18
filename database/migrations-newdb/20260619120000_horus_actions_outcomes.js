/**
 * Horus — Track Razonamiento (Horus.R), Sprint R4: verificación de resultado (L3).
 *
 * Cierra el lazo de mi loop (observo→diagnostico→decido→propongo→apruebo→ejecuto→
 * VERIFICO→aprendo). Cuando una acción aprobada MADURA (~4 semanas), el motor mide si
 * funcionó: diff-in-diff del métrico del sujeto (después vs antes) descontando la
 * tendencia del tenant en el mismo período → veredicto. La efectividad agregada por
 * causa/acción es el aprendizaje L3 (qué prescripciones mueven la aguja).
 *
 * Ship-collector-before-learner (ADR-021): este sprint construye el COLECTOR (medición
 * + veredicto + scorecard). El LEARNER (que la efectividad ajuste confianza/prioridad,
 * L4) queda DIFERIDO hasta que haya ~3-4 semanas de outcomes reales — gate por
 * calendario, no por código. Hoy el scorecard está vacío y se llena solo.
 *
 *   - outcome_status   pending | measured | insufficient_data
 *   - outcome_verdict  worked | no_effect | backfired | inconclusive (null hasta medir)
 *   - outcome_delta    efecto NETO (Δsujeto − Δtenant), en puntos del métrico
 *   - outcome_detail   {metric, before, after, delta, control, net, n_before, n_after, post_days}
 *   - outcome_measured_at
 *
 * Determinista, auditable, sin LLM. Idempotente: hasColumn antes de addColumn.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasCol = (c) => knex.schema.withSchema('commercial').hasColumn('supervisor_actions', c);

  if (!(await hasCol('outcome_status'))) {
    await knex.schema.withSchema('commercial').alterTable('supervisor_actions', (t) => {
      t.string('outcome_status', 20).notNullable().defaultTo('pending'); // pending|measured|insufficient_data
      t.string('outcome_verdict', 20); // worked|no_effect|backfired|inconclusive
      t.decimal('outcome_delta', 7, 2); // efecto neto (puntos)
      t.jsonb('outcome_detail'); // números que sustentan el veredicto
      t.timestamp('outcome_measured_at');
    });
  }

  await knex.raw(
    `ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_outcome_status`,
  );
  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT chk_supervisor_actions_outcome_status
      CHECK (outcome_status IN ('pending', 'measured', 'insufficient_data'))
  `);
  await knex.raw(
    `ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_outcome_verdict`,
  );
  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT chk_supervisor_actions_outcome_verdict
      CHECK (outcome_verdict IS NULL OR outcome_verdict IN ('worked', 'no_effect', 'backfired', 'inconclusive'))
  `);
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_supervisor_actions_outcome ON commercial.supervisor_actions (tenant_id, status, outcome_status)`,
  );
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_supervisor_actions_outcome`);
  await knex.raw(`ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_outcome_status`);
  await knex.raw(`ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_outcome_verdict`);
  if (await knex.schema.withSchema('commercial').hasColumn('supervisor_actions', 'outcome_status')) {
    await knex.schema.withSchema('commercial').alterTable('supervisor_actions', (t) => {
      t.dropColumn('outcome_status');
      t.dropColumn('outcome_verdict');
      t.dropColumn('outcome_delta');
      t.dropColumn('outcome_detail');
      t.dropColumn('outcome_measured_at');
    });
  }
};
