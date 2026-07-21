/**
 * Smoke Horus.ACT.1+4 (DB-level): valida que los CHECK extendidos aceptan
 * source='plan' + action_type='notify_missed_visit', y que la query de cartera
 * planeada del día corre sin error de SQL. No levanta el API.
 */
const knex = require('knex')(require('../knexfile-newdb').development);

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUBJ = '00000000-0000-0000-0000-0000000ac701'; // uuid sintético (subject_id sin FK)
let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  ✓', m); };
const bad = (m, e) => { fail++; console.log('  ✗', m, e ? '— ' + e.message : ''); };

(async () => {
  // 1) source='plan' aceptado por el CHECK.
  let findingId = null;
  try {
    const [row] = await knex('commercial.supervisor_findings')
      .insert({
        tenant_id: TENANT,
        dedup_key: `missed_visit:collaborator:${SUBJ}:SMOKE`,
        finding_type: 'missed_visit',
        severity: 'warn',
        subject_type: 'collaborator',
        subject_id: SUBJ,
        label: 'SMOKE vendedor',
        score: 3,
        evidence: JSON.stringify({ planned: 5, visited: 2, missed: 3, date: 'SMOKE' }),
        source: 'plan',
        status: 'open',
      })
      .returning('id');
    findingId = row?.id || row;
    ok("supervisor_findings acepta source='plan'");
  } catch (e) {
    bad("supervisor_findings source='plan'", e);
  }

  // 2) action_type='notify_missed_visit' aceptado por el CHECK.
  let actionId = null;
  try {
    const [row] = await knex('commercial.supervisor_actions')
      .insert({
        tenant_id: TENANT,
        finding_id: findingId,
        dedup_key: `notify_missed_visit:collaborator:${SUBJ}:missed_visit:SMOKE`,
        action_type: 'notify_missed_visit',
        kind: 'finding',
        subject_type: 'collaborator',
        subject_id: SUBJ,
        title: 'SMOKE escalar visitas faltantes',
        payload: JSON.stringify({}),
        status: 'pending_approval',
        proposed_by: 'horus',
      })
      .returning('id');
    actionId = row?.id || row;
    ok("supervisor_actions acepta action_type='notify_missed_visit'");
  } catch (e) {
    bad("supervisor_actions action_type='notify_missed_visit'", e);
  }

  // 3) coaching_notes acepta category='incident' (sin CHECK).
  let noteId = null;
  try {
    const [row] = await knex('commercial.coaching_notes')
      .insert({
        tenant_id: TENANT,
        collaborator_id: SUBJ,
        finding_id: findingId,
        category: 'incident',
        message: 'SMOKE hoy quedaron 3 tiendas sin visitar',
        status: 'open',
      })
      .returning('id');
    noteId = row?.id || row;
    ok("coaching_notes acepta category='incident'");
  } catch (e) {
    bad("coaching_notes category='incident'", e);
  }

  // 4) La query de cartera planeada del día corre sin error (0+ filas OK).
  try {
    const anyUser = await knex('public.daily_assignments').select('user_id').first();
    const uid = anyUser?.user_id || SUBJ;
    await knex('commercial.customers as c')
      .where('c.tenant_id', TENANT)
      .whereNull('c.deleted_at')
      .whereRaw(
        `(
          (c.visit_days IS NULL OR cardinality(c.visit_days) = 0
           OR c.visit_days @> ARRAY[EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::smallint])
          AND EXISTS (
            SELECT 1 FROM public.daily_assignments da
            JOIN public.catalogs cat ON cat.id = da.route_id AND cat.catalog_id = 'rutas' AND cat.deleted_at IS NULL
            WHERE da.user_id = ? AND cat.value = c.sales_route
              AND da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int
          )
        )`,
        [uid],
      )
      .select('c.id')
      .limit(1);
    ok('query cartera-planeada-del-día ejecuta sin error de SQL');
  } catch (e) {
    bad('query cartera-planeada-del-día', e);
  }

  // Limpieza.
  try {
    if (noteId) await knex('commercial.coaching_notes').where({ id: noteId }).del();
    if (actionId) await knex('commercial.supervisor_actions').where({ id: actionId }).del();
    if (findingId) await knex('commercial.supervisor_findings').where({ id: findingId }).del();
    ok('cleanup');
  } catch (e) {
    bad('cleanup', e);
  }

  console.log(`\nHorus missed_visit smoke: ${pass} pass / ${fail} fail`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
