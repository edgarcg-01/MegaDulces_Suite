/* eslint-disable no-console */
/**
 * Smoke HTTP — Thot T.R0: motor de findings comerciales.
 *
 * Verifica end-to-end:
 *   POST /commercial/intelligence/findings/compute  → genera findings (open/resolved/capped)
 *   GET  /commercial/intelligence/findings           → bandeja (default open), priorizada
 *   POST /commercial/intelligence/findings/:id/review→ dismiss + IDEMPOTENCIA (no reaparece)
 * + inyección sintética: zone_demand rank=1 de un producto SIN presencia PdV → distribution_gap.
 *
 * Requisitos: API :3334 con T.R0 + migraciones aplicadas (npm run migrate:new).
 * Login superoot (manage:all) pasa el gate COMMERCIAL_ORDERS_VER/CUSTOMERS_GESTIONAR.
 * Correr: node database/tests/http-thot-findings-test.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const BASE = 'http://localhost:3334/api';

let pass = 0,
  fail = 0;
const failures = [];
function check(name, cond, det) {
  if (cond) {
    console.log(`  OK   ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${det !== undefined ? ` — ${JSON.stringify(det)}` : ''}`);
    failures.push(name);
    fail++;
  }
}
async function req(method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch (_) {}
  return { status: r.status, body: json };
}

(async () => {
  console.log('── 1. Login superoot ──');
  const lr = await fetch(`${BASE}/auth-mt/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' }),
  });
  const token = (await lr.json())?.access_token;
  check('JWT recibido', !!token);
  if (!token) {
    console.log('FATAL sin token');
    process.exit(1);
  }

  console.log('\n── 2. POST /findings/compute (genera findings comerciales) ──');
  const c = await req('POST', '/commercial/intelligence/findings/compute', token, {});
  check('compute 2xx', c.status === 200 || c.status === 201, c.status);
  check('devuelve {open, resolved} numéricos', c.body && typeof c.body.open === 'number' && typeof c.body.resolved === 'number', c.body);

  console.log('\n── 3. GET /findings (bandeja) + desglose por tipo (dato real) ──');
  const l = await req('GET', '/commercial/intelligence/findings', token);
  check('GET /findings 200', l.status === 200, l.status);
  const byType = {};
  for (const f of l.body?.rows || []) byType[f.finding_type] = (byType[f.finding_type] || 0) + 1;
  console.log(`     findings abiertos=${(l.body?.rows || []).length} · por tipo=${JSON.stringify(byType)}`);
  check('rows es arreglo', Array.isArray(l.body?.rows), typeof l.body?.rows);

  console.log('\n── 4. Inyección sintética: distribution_gap (zone_demand rank=1, 0 PdVs) ──');
  // Producto existente SIN presencia PdV → pdv_count=0 garantizado.
  const prod = (
    await knex.raw(
      `SELECT p.id, p.nombre FROM catalog.products p
       LEFT JOIN intelligence.pdv_presence pv ON pv.product_id = p.id AND pv.tenant_id = ?
       WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND pv.product_id IS NULL
       LIMIT 1`,
      [T, T],
    )
  ).rows[0];
  check('hay un producto sin presencia PdV para el test', !!prod, prod || 'ninguno');
  if (prod) {
    const cleanR0 = async () => {
      await knex('intelligence.zone_demand').where({ tenant_id: T, zona: '__thot_r0_zone__' }).del();
      await knex('commercial.commercial_findings').where({ tenant_id: T, subject_id: prod.id, finding_type: 'distribution_gap' }).del();
    };
    await cleanR0();
    await knex('intelligence.zone_demand').insert({
      tenant_id: T,
      zona: '__thot_r0_zone__',
      product_id: prod.id,
      units: 100,
      revenue: 1000,
      demand_index: 0.9,
      rank: 1,
    });
    await req('POST', '/commercial/intelligence/findings/compute', token, {});
    const dg = await knex('commercial.commercial_findings')
      .where({ tenant_id: T, subject_id: prod.id, finding_type: 'distribution_gap' })
      .first();
    check('distribution_gap disparó sobre el producto top-demanda sin PdVs', !!dg, dg ? { sev: dg.severity, st: dg.subject_type } : 'sin finding');
    if (dg) {
      check('subject_type = product', dg.subject_type === 'product', dg.subject_type);
      const ev = typeof dg.evidence === 'string' ? JSON.parse(dg.evidence) : dg.evidence;
      check('evidencia explicable (zona + demand_rank=1 + pdv_count=0)', ev && ev.zona === '__thot_r0_zone__' && Number(ev.demand_rank) === 1 && Number(ev.pdv_count) === 0, ev);

      console.log('\n── 5. Review: dismiss → NO se reabre al recomputar (decisión humana) ──');
      const rv = await req('POST', `/commercial/intelligence/findings/${dg.id}/review`, token, { status: 'dismissed' });
      check('review dismiss 2xx', rv.status === 200 || rv.status === 201, rv.status);
      await req('POST', '/commercial/intelligence/findings/compute', token, {});
      const after = await knex('commercial.commercial_findings').where({ id: dg.id }).first();
      check('finding descartado NO se reabre (respeta decisión humana)', after && after.status === 'dismissed', after ? after.status : 'desaparecido');
    }
    await cleanR0();
    const gone = await knex('commercial.commercial_findings').where({ tenant_id: T, subject_id: prod.id, finding_type: 'distribution_gap' }).first();
    check('cleanup R0 OK (sin finding sintético residual)', !gone, gone);
  }

  console.log('\n── 6. T.R1: diagnóstico de causa raíz (correlación de findings) ──');
  const PX = '0000000b-0000-0000-0000-0000000000d1'; // producto sintético: 2 findings → diagnóstico
  const PY = '0000000b-0000-0000-0000-0000000000d2'; // atómico: 1 finding
  const cleanR1 = async () => {
    await knex('commercial.commercial_diagnoses').where({ tenant_id: T }).whereIn('subject_id', [PX, PY]).del();
    await knex('commercial.commercial_findings').where({ tenant_id: T }).whereIn('subject_id', [PX, PY]).del();
  };
  await cleanR1();
  await knex('commercial.commercial_findings').insert([
    { tenant_id: T, dedup_key: `low_rotation_priced:product:${PX}`, finding_type: 'low_rotation_priced', severity: 'warn', subject_type: 'product', subject_id: PX, label: '__r1_diag_prod__', score: 50, evidence: JSON.stringify({ rotation_tier: 'baja', sales_units_30d: 0, price: 10 }), source: 'engine', status: 'open' },
    { tenant_id: T, dedup_key: `margin_laggard:product:${PX}`, finding_type: 'margin_laggard', severity: 'critical', subject_type: 'product', subject_id: PX, label: '__r1_diag_prod__', score: 20, evidence: JSON.stringify({ margin_pct: -3, price: 10, cost_with_tax: 10 }), source: 'engine', status: 'open' },
    { tenant_id: T, dedup_key: `margin_laggard:product:${PY}`, finding_type: 'margin_laggard', severity: 'warn', subject_type: 'product', subject_id: PY, label: '__r1_atomic_prod__', score: 5, evidence: JSON.stringify({ margin_pct: 5 }), source: 'engine', status: 'open' },
  ]);
  await req('POST', '/commercial/intelligence/diagnoses/compute', token, {});
  const diag = await knex('commercial.commercial_diagnoses').where({ tenant_id: T, subject_id: PX, root_cause: 'unprofitable_deadweight' }).first();
  check('diagnóstico unprofitable_deadweight correlaciona rotación + margen', !!diag, diag ? { sev: diag.severity, conf: diag.confidence } : 'sin diagnóstico');
  if (diag) {
    const fids = typeof diag.finding_ids === 'string' ? JSON.parse(diag.finding_ids) : diag.finding_ids;
    check('linkea ≥2 findings', Array.isArray(fids) && fids.length >= 2, fids);
    check('severidad = critical (hereda del peor síntoma)', diag.severity === 'critical', diag.severity);
    const ev = typeof diag.evidence === 'string' ? JSON.parse(diag.evidence) : diag.evidence;
    check('evidence action_hint=delist_or_liquidate + symptoms (≥2)', ev && ev.action_hint === 'delist_or_liquidate' && Array.isArray(ev.symptoms) && ev.symptoms.length >= 2, ev);
  }
  const atomic = await knex('commercial.commercial_diagnoses').where({ tenant_id: T, subject_id: PY }).first();
  check('1 finding aislado NO genera diagnóstico (atómico)', !atomic, atomic ? atomic.root_cause : 'ok');
  if (diag) {
    const rv = await req('POST', `/commercial/intelligence/diagnoses/${diag.id}/review`, token, { status: 'dismissed' });
    check('review diagnóstico dismiss 2xx', rv.status === 200 || rv.status === 201, rv.status);
    await req('POST', '/commercial/intelligence/diagnoses/compute', token, {});
    const after = await knex('commercial.commercial_diagnoses').where({ id: diag.id }).first();
    check('diagnóstico descartado NO se reabre (decisión humana)', after && after.status === 'dismissed', after ? after.status : 'desaparecido');
  }
  await cleanR1();
  const goneR1 = await knex('commercial.commercial_diagnoses').where({ tenant_id: T }).whereIn('subject_id', [PX, PY]).first();
  check('cleanup R1 OK (sin diagnóstico sintético residual)', !goneR1, goneR1);

  console.log('\n── 7. T.R2: co-piloto (push real + impacto $ + aprobar) ──');
  // Parte A: push_product sobre producto REAL → al aprobar crea un push_directive real.
  const rp = (
    await knex.raw(
      `SELECT p.id, p.nombre FROM catalog.products p
       LEFT JOIN intelligence.pdv_presence pv ON pv.product_id = p.id AND pv.tenant_id = ?
       WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND pv.product_id IS NULL LIMIT 1`,
      [T, T],
    )
  ).rows[0];
  check('hay producto real para el push', !!rp, rp || 'ninguno');
  if (rp) {
    const cleanA = async () => {
      await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: rp.id }).del();
      await knex('commercial.commercial_findings').where({ tenant_id: T, subject_id: rp.id }).del();
      await knex('intelligence.push_directives').where({ tenant_id: T, target_id: rp.id }).whereRaw("reason ILIKE 'Thot:%'").del();
    };
    await cleanA();
    // Solo distribution_gap (1 finding → atómico → push_product, sin diagnóstico).
    await knex('commercial.commercial_findings').insert({
      tenant_id: T, dedup_key: `distribution_gap:product:${rp.id}`, finding_type: 'distribution_gap', severity: 'warn',
      subject_type: 'product', subject_id: rp.id, label: rp.nombre, score: 90,
      evidence: JSON.stringify({ zona: '__thot_r2_zone__', demand_rank: 1, demand_index: 0.9, pdv_count: 0 }), source: 'engine', status: 'open',
    });
    await req('POST', '/commercial/intelligence/actions/compute', token, {});
    const act = await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: rp.id, action_type: 'push_product' }).first();
    check('push_product propuesto para el producto', !!act, act ? { conf: act.confidence, prio: act.priority } : 'sin acción');
    if (act) {
      check('acción trae confianza + prioridad', act.confidence != null && act.priority != null, { c: act.confidence, p: act.priority });
      const ap = await req('POST', `/commercial/intelligence/actions/${act.id}/approve`, token, {});
      check('approve 2xx', ap.status === 200 || ap.status === 201, ap.status);
      const res = ap.body?.result ? (typeof ap.body.result === 'string' ? JSON.parse(ap.body.result) : ap.body.result) : null;
      check('ejecutó push_directive (lazo cerrado)', res && res.effect === 'push_directive', res);
      const dir = await knex('intelligence.push_directives')
        .where({ tenant_id: T, target_id: rp.id }).whereRaw("reason ILIKE 'Thot:%'").whereNull('deleted_at').first();
      check('push_directive real creado para el producto', !!dir, dir ? dir.id : 'sin directriz');
    }
    await cleanA();
  }

  // Parte B: impacto en $ del margen (impactForFinding desde evidencia).
  const FK = '0000000b-0000-0000-0000-0000000000e1';
  await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: FK }).del();
  await knex('commercial.commercial_findings').where({ tenant_id: T, subject_id: FK }).del();
  await knex('commercial.commercial_findings').insert({
    tenant_id: T, dedup_key: `margin_laggard:product:${FK}`, finding_type: 'margin_laggard', severity: 'warn',
    subject_type: 'product', subject_id: FK, label: '__r2_margin__', score: 13,
    evidence: JSON.stringify({ margin_pct: 2, price: 20, cost_with_tax: 19, threshold_pct: 8 }), source: 'engine', status: 'open',
  });
  await req('POST', '/commercial/intelligence/actions/compute', token, {});
  const mAct = await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: FK, action_type: 'review_price' }).first();
  check('review_price propuesto con impacto $', !!mAct, mAct ? mAct.action_type : 'sin acción');
  if (mAct) {
    const imp = mAct.expected_impact ? (typeof mAct.expected_impact === 'string' ? JSON.parse(mAct.expected_impact) : mAct.expected_impact) : null;
    // uplift per-unidad = (15 - 2)/100 * 20 = 2.6
    check('expected_impact $ calculado desde evidencia (≈2.6)', imp && imp.kind === 'per_unit_margin_uplift_mxn' && Math.abs(Number(imp.value) - 2.6) < 0.01, imp);
  }
  await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: FK }).del();
  await knex('commercial.commercial_findings').where({ tenant_id: T, subject_id: FK }).del();
  check('cleanup R2 OK', true);

  console.log('\n── 8. T.R3: explicación del razonamiento de una acción (cadena + agente) ──');
  const GK = '0000000b-0000-0000-0000-0000000000f1';
  await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: GK }).del();
  await knex('commercial.commercial_findings').where({ tenant_id: T, subject_id: GK }).del();
  await knex('commercial.commercial_findings').insert({
    tenant_id: T, dedup_key: `margin_laggard:product:${GK}`, finding_type: 'margin_laggard', severity: 'warn',
    subject_type: 'product', subject_id: GK, label: '__r3_explain__', score: 10,
    evidence: JSON.stringify({ margin_pct: 3, price: 25, cost_with_tax: 24, threshold_pct: 8 }), source: 'engine', status: 'open',
  });
  await req('POST', '/commercial/intelligence/actions/compute', token, {});
  const exAct = await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: GK, action_type: 'review_price' }).first();
  check('hay acción para explicar', !!exAct, exAct ? exAct.action_type : 'sin acción');
  if (exAct) {
    const ex = await req('GET', `/commercial/intelligence/actions/${exAct.id}/explain`, token);
    check('GET /actions/:id/explain 200', ex.status === 200, ex.status);
    check('narrativa no vacía', typeof ex.body?.narrative === 'string' && ex.body.narrative.length > 10, ex.body?.narrative);
    check('source ∈ {llm, template}', ['llm', 'template'].includes(ex.body?.source), ex.body?.source);
    const chain = ex.body?.reasoning_chain || [];
    const steps = chain.map((c) => c.step);
    check('cadena con decisión + confianza', steps.includes('decisión') && steps.includes('confianza'), steps);
    const bad = await req('GET', '/commercial/intelligence/actions/not-a-uuid/explain', token);
    check('explain id inválido → 400', bad.status === 400, bad.status);
  }
  await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: GK }).del();
  await knex('commercial.commercial_findings').where({ tenant_id: T, subject_id: GK }).del();
  check('cleanup R3 OK', true);

  console.log('\n── 9. T.L2: calibración aprendida (precisión por regla + override) ──');
  const RULE = '__test_rule__';
  const cleanL2 = async () => {
    await knex('commercial.commercial_findings').where({ tenant_id: T, finding_type: RULE }).del();
    await knex('commercial.commercial_rule_stats').where({ tenant_id: T, finding_type: RULE }).del();
  };
  await cleanL2();
  // 10 juicios: 1 confirmada, 9 descartadas → precisión 0.1 (<0.2) con floor (≥8) → suprime.
  const judged = [];
  for (let i = 0; i < 10; i++) {
    const sid = `0000000c-0000-0000-0000-${String(i).padStart(12, '0')}`;
    judged.push({
      tenant_id: T, dedup_key: `${RULE}:product:${sid}`, finding_type: RULE, severity: 'warn',
      subject_type: 'product', subject_id: sid, label: '__l2_test__', score: 1,
      evidence: '{}', source: 'engine', status: i === 0 ? 'confirmed' : 'dismissed',
    });
  }
  await knex('commercial.commercial_findings').insert(judged);
  const rc = await req('POST', '/commercial/intelligence/learning/recompute', token, {});
  check('learning/recompute 2xx', rc.status === 200 || rc.status === 201, rc.status);
  const stat = await knex('commercial.commercial_rule_stats').where({ tenant_id: T, finding_type: RULE }).first();
  check('precisión calculada ≈ 0.1', stat && Math.abs(Number(stat.precision) - 0.1) < 0.001, stat ? stat.precision : 'sin stat');
  check('floor alcanzado (10 ≥ 8) + auto-suprimida (<0.2)', stat && stat.floor_met && stat.auto_suppressed, stat ? { floor: stat.floor_met, sup: stat.auto_suppressed } : '?');

  // Override humano: reactivar → effective NO suprimida (el learner no lo pisa).
  const ov = await req('POST', `/commercial/intelligence/learning/rules/${RULE}/override`, token, { override: 'enabled' });
  check('override enabled 2xx', ov.status === 200 || ov.status === 201, ov.status);
  const rules = await req('GET', '/commercial/intelligence/learning/rules', token);
  const row = (rules.body?.rows || []).find((r) => r.finding_type === RULE);
  check('override humano gana: effective_suppressed=false', row && row.effective_suppressed === false, row ? row.effective_suppressed : 'sin fila');

  await cleanL2();
  const goneL2 = await knex('commercial.commercial_rule_stats').where({ tenant_id: T, finding_type: RULE }).first();
  check('cleanup L2 OK', !goneL2, goneL2);

  console.log('\n── 10. ADR-023: autonomía acotada (OFF → habilitar dial → auto-ejecuta) ──');
  const rpA = (
    await knex.raw(
      `SELECT p.id, p.nombre FROM catalog.products p
       LEFT JOIN intelligence.pdv_presence pv ON pv.product_id = p.id AND pv.tenant_id = ?
       WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND pv.product_id IS NULL LIMIT 1`,
      [T, T],
    )
  ).rows[0];
  check('hay producto real para autonomía', !!rpA, rpA || 'ninguno');
  if (rpA) {
    const cleanADR = async () => {
      await knex('commercial.commercial_actions').where({ tenant_id: T, status: 'pending_approval' }).del(); // slate limpio (se re-proponen luego)
      await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: rpA.id }).del();
      await knex('intelligence.push_directives').where({ tenant_id: T, target_id: rpA.id }).whereRaw("reason ILIKE 'Thot:%'").del();
      await knex('commercial.autonomy_policies').where({ tenant_id: T }).whereIn('action_type', ['__global__', 'push_product']).del();
    };
    await cleanADR();
    // Una acción push_product pendiente, aislada (confianza 0.6 cold-start).
    await knex('commercial.commercial_actions').insert({
      tenant_id: T, dedup_key: `push_product:product:${rpA.id}:adr022`, kind: 'finding', action_type: 'push_product',
      subject_type: 'product', subject_id: rpA.id, label: rpA.nombre, title: 'Empujar (test ADR-023)',
      payload: '{}', confidence: 0.6, priority: 1.2, proposed_by: 'thot', status: 'pending_approval',
    });

    // (a) Dial OFF (default) → NO auto-ejecuta.
    const off = await req('POST', '/commercial/intelligence/autonomy/run', token, {});
    check('dial OFF: no auto-ejecuta (auto=0)', off.body?.auto === 0, off.body);
    const sp = await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: rpA.id }).first();
    check('la acción sigue pendiente (co-piloto)', sp && sp.status === 'pending_approval', sp ? sp.status : 'desaparecida');

    // (b) Habilitar dial: kill-switch global + push_product en auto (umbral 0.5).
    await req('PATCH', '/commercial/intelligence/autonomy/policies/__global__', token, { mode: 'auto' });
    await req('PATCH', '/commercial/intelligence/autonomy/policies/push_product', token, { mode: 'auto', min_confidence: 0.5, daily_cap: 5 });
    const run = await req('POST', '/commercial/intelligence/autonomy/run', token, {});
    check('con dial auto: auto-ejecuta ≥1', (run.body?.auto || 0) >= 1, run.body);
    const ex = await knex('commercial.commercial_actions').where({ tenant_id: T, subject_id: rpA.id }).first();
    check('ejecutada SIN aprobación (status=executed, auto_executed=true)', ex && ex.status === 'executed' && ex.auto_executed === true, ex ? { s: ex.status, a: ex.auto_executed } : '?');
    const dir = await knex('intelligence.push_directives').where({ tenant_id: T, target_id: rpA.id }).whereRaw("reason ILIKE 'Thot:%'").whereNull('deleted_at').first();
    check('auto-ejecución creó el push_directive real (lazo cerrado)', !!dir, dir ? dir.id : 'sin directriz');
    const log = await req('GET', '/commercial/intelligence/autonomy/log', token);
    check('aparece en el panel "Thot actuó solo"', (log.body?.rows || []).length >= 1, (log.body?.rows || []).length);

    // (c) Gate de confianza: subir el umbral por encima de la confianza → vuelve a co-piloto.
    await knex('commercial.commercial_actions').insert({
      tenant_id: T, dedup_key: `push_product:product:${rpA.id}:adr022b`, kind: 'finding', action_type: 'push_product',
      subject_type: 'product', subject_id: rpA.id, label: rpA.nombre, title: 'Empujar 2 (test gate)',
      payload: '{}', confidence: 0.6, priority: 1.2, proposed_by: 'thot', status: 'pending_approval',
    });
    await req('PATCH', '/commercial/intelligence/autonomy/policies/push_product', token, { mode: 'auto', min_confidence: 0.9 });
    await req('POST', '/commercial/intelligence/autonomy/run', token, {});
    const gated = await knex('commercial.commercial_actions').where({ tenant_id: T, dedup_key: `push_product:product:${rpA.id}:adr022b` }).first();
    check('confianza < umbral → NO auto (autoridad ganada): sigue pendiente', gated && gated.status === 'pending_approval', gated ? gated.status : '?');

    await cleanADR();
    const goneADR = await knex('commercial.autonomy_policies').where({ tenant_id: T }).whereIn('action_type', ['__global__', 'push_product']).first();
    check('cleanup ADR-023 OK (kill-switch reseteado a OFF)', !goneADR, goneADR);
  }

  console.log(`\n══ Resultado: ${pass} OK, ${fail} FAIL ══`);
  if (fail) console.log('FALLOS:', failures.join(', '));
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack || e.message);
  process.exit(1);
});
