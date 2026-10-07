/**
 * Horus 360 — K6: roll-ups por zona + supervisor en el feature store.
 *
 * Amplía el CHECK de execution_360.subject_type para admitir 'zone' y 'supervisor'
 * (antes: collaborator|route|store). Habilita diagnóstico a nivel ORG: qué zona /
 * qué equipo de supervisor ejecuta peor, no solo el colaborador individual.
 *
 * Datos: users.zona_id (89%) + users.supervisor_id (71%) → el roll-up agrega los
 * mismos números directos de daily_captures por la zona/supervisor del colaborador.
 * Las reglas low_score/score_drop se amplían a estos sujetos (FindingsEngine).
 * supervisor_findings/execution_360_snapshots/baselines NO tienen CHECK en
 * subject_type → no requieren cambio.
 *
 * Idempotente (DROP IF EXISTS + ADD).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.execution_360 DROP CONSTRAINT IF EXISTS chk_execution_360_subject_type`);
  await knex.raw(`
    ALTER TABLE commercial.execution_360
      ADD CONSTRAINT chk_execution_360_subject_type
      CHECK (subject_type IN ('collaborator', 'route', 'store', 'zone', 'supervisor'))
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.execution_360 DROP CONSTRAINT IF EXISTS chk_execution_360_subject_type`);
  await knex.raw(`
    ALTER TABLE commercial.execution_360
      ADD CONSTRAINT chk_execution_360_subject_type
      CHECK (subject_type IN ('collaborator', 'route', 'store'))
  `);
};
