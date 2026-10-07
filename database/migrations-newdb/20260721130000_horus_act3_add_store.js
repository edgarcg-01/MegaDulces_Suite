/**
 * Horus — Sprint Horus.ACT.3: alta de tienda de oportunidad (INEGI/DENUE).
 *
 * Amplía el CHECK `supervisor_actions.action_type` con `'add_opportunity_store'`:
 * la oportunidad que Horus propone desde `commercial.prospect_stores` (whitespace
 * alto, sin cobertura). Al aprobar, el ejecutor crea `commercial.customers`
 * (pedible) + marca el prospecto convertido.
 *
 * ACT.2 (reorden real de ruta) NO necesita migración: reusa `reprioritize_route`
 * (ya en el CHECK) y escribe `commercial.customers.visit_sequence`.
 *
 * Idempotente: DROP CONSTRAINT IF EXISTS + ADD, preservando el set vigente
 * (incluye 'notify_missed_visit' de la 20260721120000).
 *
 * @param { import("knex").Knex } knex
 */
const FULL_SET = `(
  'coaching', 'visit', 'flag_review',
  'coaching_focus', 'recover_shelf', 'reprioritize_route', 'replicate_best',
  'schedule_visit', 'flag_recapture', 'set_target', 'escalate',
  'notify_missed_visit', 'add_opportunity_store'
)`;

const PREV_SET = `(
  'coaching', 'visit', 'flag_review',
  'coaching_focus', 'recover_shelf', 'reprioritize_route', 'replicate_best',
  'schedule_visit', 'flag_recapture', 'set_target', 'escalate',
  'notify_missed_visit'
)`;

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_type`);
  await knex.raw(
    `ALTER TABLE commercial.supervisor_actions ADD CONSTRAINT chk_supervisor_actions_type CHECK (action_type IN ${FULL_SET})`,
  );
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_type`);
  await knex.raw(
    `ALTER TABLE commercial.supervisor_actions ADD CONSTRAINT chk_supervisor_actions_type CHECK (action_type IN ${PREV_SET})`,
  );
};
