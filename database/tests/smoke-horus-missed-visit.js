/**
 * Smoke Horus.ACT (DB-level, sin API): valida los CHECK extendidos y las
 * primitivas SQL de los ejecutores.
 *   ACT.1/4 — source='plan' + action_type='notify_missed_visit' + category='incident'
 *             + query de cartera planeada del día.
 *   ACT.2   — reorden real de visit_sequence (round-trip sobre una ruta real).
 *   ACT.3   — action_type='add_opportunity_store' + alta de cliente + markConverted.
 */
const { randomBytes } = require('crypto');
const knex = require('knex')(require('../knexfile-newdb').development);

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const SUBJ = '00000000-0000-0000-0000-0000000ac701'; // uuid sintético (subject_id sin FK)
let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  ✓', m); };
const bad = (m, e) => { fail++; console.log('  ✗', m, e ? '— ' + e.message : ''); };
const hex = () => randomBytes(5).toString('hex').toUpperCase();

(async () => {
  let findingId = null;
  let actionId = null;
  let noteId = null;
  let prospectId = null;
  let act3Id = null;
  let newCustId = null;

  // ── ACT.1 / ACT.4 ──────────────────────────────────────────────────────
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

  // ── ACT.2 — reorden real de visit_sequence (round-trip sobre ruta real) ──
  try {
    const route = await knex('commercial.customers')
      .where({ tenant_id: TENANT })
      .whereNull('deleted_at')
      .whereNotNull('sales_route')
      .groupBy('sales_route')
      .havingRaw('count(*) >= 2')
      .select('sales_route')
      .first();
    if (!route) {
      ok('ACT.2 reorden — sin ruta con ≥2 clientes (skip aceptable)');
    } else {
      const rows = await knex('commercial.customers')
        .where({ tenant_id: TENANT, sales_route: route.sales_route })
        .whereNull('deleted_at')
        .orderByRaw('visit_sequence asc nulls last, name asc')
        .select('id', 'visit_sequence');
      const original = rows.map((r) => ({ id: r.id, seq: r.visit_sequence }));
      const reversed = rows.map((r) => r.id).reverse();
      let seq = 1;
      for (const id of reversed) {
        await knex('commercial.customers').where({ id, tenant_id: TENANT }).update({ visit_sequence: seq });
        seq++;
      }
      const first = await knex('commercial.customers').where({ id: reversed[0] }).first('visit_sequence');
      const good = Number(first.visit_sequence) === 1;
      // restaurar el orden previo (reversible, como el ejecutor guarda en result).
      for (const o of original) {
        await knex('commercial.customers').where({ id: o.id, tenant_id: TENANT }).update({ visit_sequence: o.seq });
      }
      good
        ? ok(`ACT.2 reorden visit_sequence round-trip (ruta ${route.sales_route})`)
        : bad('ACT.2 reorden visit_sequence');
    }
  } catch (e) {
    bad('ACT.2 reorden', e);
  }

  // ── ACT.3 — action_type add_opportunity_store + alta cliente + markConverted ──
  try {
    const [pr] = await knex('commercial.prospect_stores')
      .insert({
        tenant_id: TENANT,
        source: 'denue',
        source_ref: 'SMOKE-' + hex(),
        nombre: 'SMOKE Prospecto',
        lat: 20.34,
        lng: -102.03,
        status: 'candidate',
        whitespace_score: 80,
      })
      .returning('id');
    prospectId = pr?.id || pr;

    const [a] = await knex('commercial.supervisor_actions')
      .insert({
        tenant_id: TENANT,
        dedup_key: 'opp:add_opportunity_store:prospect:' + prospectId,
        action_type: 'add_opportunity_store',
        kind: 'opportunity',
        subject_type: 'prospect',
        subject_id: prospectId,
        title: 'SMOKE alta de oportunidad',
        payload: JSON.stringify({ prospect_id: prospectId, name: 'SMOKE Prospecto' }),
        status: 'pending_approval',
        proposed_by: 'horus',
      })
      .returning('id');
    act3Id = a?.id || a;
    ok("supervisor_actions acepta action_type='add_opportunity_store'");

    // Ejecutor (primitivas SQL): crea cliente + markConverted.
    const [c] = await knex('commercial.customers')
      .insert({
        tenant_id: TENANT,
        code: 'P-SMOKE-' + hex(),
        name: 'SMOKE Prospecto',
        credit_limit: 0,
        payment_terms_days: 0,
        active: true,
        latitude: 20.34,
        longitude: -102.03,
      })
      .returning('id');
    newCustId = c?.id || c;
    await knex('commercial.prospect_stores')
      .where({ tenant_id: TENANT, id: prospectId })
      .update({ status: 'converted', matched_customer_id: newCustId });
    const conv = await knex('commercial.prospect_stores').where({ id: prospectId }).first('status', 'matched_customer_id');
    conv.status === 'converted' && conv.matched_customer_id === newCustId
      ? ok('ACT.3 alta de cliente + markConverted')
      : bad('ACT.3 markConverted');
  } catch (e) {
    bad('ACT.3 add_opportunity_store', e);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  try {
    if (newCustId) await knex('commercial.customers').where({ id: newCustId }).del();
    if (act3Id) await knex('commercial.supervisor_actions').where({ id: act3Id }).del();
    if (prospectId) await knex('commercial.prospect_stores').where({ id: prospectId }).del();
    if (noteId) await knex('commercial.coaching_notes').where({ id: noteId }).del();
    if (actionId) await knex('commercial.supervisor_actions').where({ id: actionId }).del();
    if (findingId) await knex('commercial.supervisor_findings').where({ id: findingId }).del();
    ok('cleanup');
  } catch (e) {
    bad('cleanup', e);
  }

  console.log(`\nHorus.ACT smoke: ${pass} pass / ${fail} fail`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
