/**
 * Horus — Sprint Horus.ACT (ACT.1 + ACT.4): visita planeada NO realizada.
 *
 * Habilita dos valores nuevos en los CHECK existentes de Horus:
 *   - supervisor_findings.source += 'plan'  → el motor de plan de visita
 *     (MissedVisitEngineService) emite `missed_visit` cruzando la cartera
 *     planeada del día (daily_assignments + customers.sales_route/visit_days)
 *     contra commercial.vendor_visits. Source propio para que el resolve del
 *     motor de findings (source='engine') NO lo pise, igual que 'fraud'/'vision'.
 *   - supervisor_actions.action_type += 'notify_missed_visit' → la acción del
 *     co-piloto que escala la incidencia al supervisor (web). El aviso al
 *     vendedor (app) es automático desde el motor (coaching_notes category
 *     'incident' + nudge WS); esta acción es la parte que el supervisor APRUEBA.
 *
 * `coaching_notes.category` NO tiene CHECK → 'incident' entra sin tocar schema.
 * `finding_type` es varchar(40) libre → 'missed_visit' entra sin CHECK.
 *
 * Idempotente: DROP CONSTRAINT IF EXISTS + ADD, preservando el set vigente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.supervisor_findings DROP CONSTRAINT IF EXISTS chk_supervisor_findings_source`);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_findings
      ADD CONSTRAINT chk_supervisor_findings_source
      CHECK (source IN ('engine', 'vision', 'embedding', 'fraud', 'plan'))
  `);

  await knex.raw(`ALTER TABLE commercial.supervisor_actions DROP CONSTRAINT IF EXISTS chk_supervisor_actions_type`);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_actions
      ADD CONSTRAINT chk_supervisor_actions_type
      CHECK (action_type IN (
        'coaching', 'visit', 'flag_review',
        'coaching_focus', 'recover_shelf', 'reprioritize_route', 'replicate_best',
        'schedule_visit', 'flag_recapture', 'set_target', 'escalate',
        'notify_missed_visit'
      ))
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.supervisor_findings DROP CONSTRAINT IF EXISTS chk_supervisor_findings_source`);
  await knex.raw(`
    ALTER TABLE commercial.supervisor_findings
      ADD CONSTRAINT chk_supervisor_findings_source
      CHECK (source IN ('engine', 'vision', 'embedding', 'fraud'))
  `);

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
};
