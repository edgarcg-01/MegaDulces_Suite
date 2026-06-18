/* eslint-disable no-console */
/**
 * Smoke HTTP — Horus (Supervisor AI de ejecución, Trade). Sprints Horus.0 + .1.
 *
 * Verifica end-to-end:
 *   POST /supervisor-ai/compute              → computa feature store + findings
 *   GET  /supervisor-ai/execution-360        → feature store (collaborator/store ×7/30d)
 *   GET  /supervisor-ai/execution-360?...    → filtros subject_type + window_days
 *   GET  /supervisor-ai/findings             → bandeja (default open), priorizada
 *   POST /supervisor-ai/findings/:id/review  → dismiss + IDEMPOTENCIA (no reaparece)
 * + id inválido (400) + status inválido (400) + validación cruzada con la DB.
 *
 * Requisitos: API :3334 con Horus.0+.1 + migraciones aplicadas (npm run migrate:new).
 * Login superoot (manage:all) pasa el gate SUPERVISOR_AI_VER/APROBAR.
 * Correr: node database/tests/http-horus-test.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
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

  console.log('\n── 2. POST /supervisor-ai/compute (feature store + findings) ──');
  const c = await req('POST', '/supervisor-ai/compute', token, {});
  check('compute 2xx', c.status === 200 || c.status === 201, c.status);
  check('feature_store.rows_upserted > 0', (c.body?.feature_store?.rows_upserted || 0) > 0, c.body?.feature_store);
  check(
    'findings devuelve {open, resolved} numéricos',
    c.body?.findings && typeof c.body.findings.open === 'number' && typeof c.body.findings.resolved === 'number',
    c.body?.findings,
  );
  console.log(
    `     rows_upserted=${c.body?.feature_store?.rows_upserted} | findings open=${c.body?.findings?.open} resolved=${c.body?.findings?.resolved}`,
  );

  console.log('\n── 3. GET /supervisor-ai/execution-360 ──');
  const e = await req('GET', '/supervisor-ai/execution-360', token);
  check('execution-360 200', e.status === 200, e.status);
  const rows = e.body?.rows || [];
  check('devuelve rows[]', rows.length > 0, rows.length);
  check(
    'cada row trae subject_type + window_days + visits_done',
    rows.every(
      (r) =>
        ['collaborator', 'route', 'store', 'zone', 'supervisor'].includes(r.subject_type) &&
        [7, 30].includes(Number(r.window_days)) &&
        typeof r.visits_done === 'number',
    ),
    rows[0],
  );
  check('hay subject_type=collaborator', rows.some((r) => r.subject_type === 'collaborator'), rows.filter((r) => r.subject_type === 'collaborator').length);
  check('hay ventanas 7 y 30', rows.some((r) => Number(r.window_days) === 7) && rows.some((r) => Number(r.window_days) === 30));
  const dbCount = await knex('commercial.execution_360').where('tenant_id', T).count('* as n').first();
  check('total endpoint == count DB', rows.length === Number(dbCount.n), { ep: rows.length, db: Number(dbCount.n) });
  const collab30 = rows.find((r) => r.subject_type === 'collaborator' && Number(r.window_days) === 30);
  console.log(`     ej. collaborator/30d: visits=${collab30?.visits_done} avg_score=${collab30?.avg_score} trend=${collab30?.score_trend}`);

  console.log('\n── 4. Filtros (subject_type=collaborator&window_days=30) ──');
  const ef = await req('GET', '/supervisor-ai/execution-360?subject_type=collaborator&window_days=30', token);
  check('filtros 200', ef.status === 200, ef.status);
  check(
    'todas collaborator + window 30',
    (ef.body?.rows || []).length > 0 && (ef.body?.rows || []).every((r) => r.subject_type === 'collaborator' && Number(r.window_days) === 30),
    (ef.body?.rows || []).slice(0, 2),
  );

  console.log('\n── 5. GET /supervisor-ai/findings (bandeja open) ──');
  const f = await req('GET', '/supervisor-ai/findings', token);
  check('findings 200', f.status === 200, f.status);
  const findings = f.body?.rows || [];
  console.log(`     findings open=${findings.length} | tipos=${[...new Set(findings.map((x) => x.finding_type))].join(',') || '—'}`);

  if (findings.length > 0) {
    check(
      'cada finding trae type+severity+status+evidence',
      findings.every(
        (x) => x.finding_type && ['info', 'warn', 'critical'].includes(x.severity) && x.status === 'open' && x.evidence,
      ),
      findings[0],
    );
    check(
      'priorizado: severidad descendente',
      (() => {
        const rank = (s) => (s === 'critical' ? 0 : s === 'warn' ? 1 : 2);
        for (let i = 1; i < findings.length; i++) if (rank(findings[i].severity) < rank(findings[i - 1].severity)) return false;
        return true;
      })(),
      findings.map((x) => x.severity),
    );

    console.log('\n── 6. POST /findings/:id/review (dismiss) + IDEMPOTENCIA ──');
    const target = findings[0];
    const rv = await req('POST', `/supervisor-ai/findings/${target.id}/review`, token, { status: 'dismissed' });
    check('review dismiss 2xx', rv.status === 200 || rv.status === 201, rv.status);
    check('finding quedó dismissed', rv.body?.status === 'dismissed', rv.body?.status);
    // Re-compute: el dismissed NO debe reaparecer como open (respeta decisión humana).
    await req('POST', '/supervisor-ai/compute', token, {});
    const fOpen = await req('GET', '/supervisor-ai/findings', token);
    check('tras recompute, el dismissed NO vuelve a open', !(fOpen.body?.rows || []).some((x) => x.id === target.id), target.id);
    const fDis = await req('GET', '/supervisor-ai/findings?status=dismissed', token);
    check('el dismissed aparece en ?status=dismissed', (fDis.body?.rows || []).some((x) => x.id === target.id), target.id);
    const dbF = await knex('commercial.supervisor_findings').where('id', target.id).first();
    check('DB: el finding sigue dismissed', dbF?.status === 'dismissed', dbF?.status);
  } else {
    console.log('  (skip review/idempotencia: 0 findings — data chica; el motor corrió OK sin hallazgos)');
  }

  console.log('\n── 7. review id inválido → 400 ──');
  const bad = await req('POST', '/supervisor-ai/findings/not-a-uuid/review', token, { status: 'dismissed' });
  check('id no-uuid → 400', bad.status === 400, bad.status);

  console.log('\n── 8. review status inválido → 400 ──');
  const badS = await req('POST', '/supervisor-ai/findings/00000000-0000-0000-0000-000000000000/review', token, { status: 'banana' });
  check('status inválido → 400', badS.status === 400, badS.status);

  console.log('\n── 9. GET /supervisor-ai/briefing (parte diario, Horus.2) ──');
  const br = await req('GET', '/supervisor-ai/briefing', token);
  check('briefing 200', br.status === 200, br.status);
  const b = br.body || {};
  check(
    'trae headline + summary (no vacíos)',
    typeof b.headline === 'string' && b.headline.length > 0 && typeof b.summary === 'string' && b.summary.length > 0,
    { h: b.headline, s: (b.summary || '').slice(0, 60) },
  );
  check('trae attention[]', Array.isArray(b.attention), b.attention);
  check(
    'trae stats (findings_total + collaborators)',
    b.stats && typeof b.stats.findings_total === 'number' && typeof b.stats.collaborators === 'number',
    b.stats,
  );
  check('source es agent|engine', b.source === 'agent' || b.source === 'engine', b.source);
  console.log(`     source=${b.source} | headline="${b.headline}" | attention=${(b.attention || []).length}`);

  console.log('\n── 10. Co-piloto: acciones (Horus.4) ──');
  await req('POST', '/supervisor-ai/compute', token, {}); // asegura acciones frescas
  const acts = await req('GET', '/supervisor-ai/actions', token);
  check('actions 200', acts.status === 200, acts.status);
  const actions = acts.body?.rows || [];
  console.log(`     acciones pending=${actions.length} | tipos=${[...new Set(actions.map((a) => a.action_type))].join(',') || '—'}`);
  if (actions.length > 0) {
    check(
      'cada acción trae title + type + status pending_approval',
      actions.every((a) => a.title && a.action_type && a.status === 'pending_approval'),
      actions[0],
    );
    const target = actions[0];
    const ap = await req('POST', `/supervisor-ai/actions/${target.id}/approve`, token, {});
    check('approve 2xx', ap.status === 200 || ap.status === 201, ap.status);
    check('acción quedó executed', ap.body?.status === 'executed', ap.body?.status);
    if (target.finding_id) {
      const dbF = await knex('commercial.supervisor_findings').where('id', target.finding_id).first();
      check('el finding asociado quedó confirmed', dbF?.status === 'confirmed', dbF?.status);
    }
    const acts2 = await req('GET', '/supervisor-ai/actions', token);
    check('la acción aprobada ya NO está en pending', !(acts2.body?.rows || []).some((a) => a.id === target.id), target.id);
    if (actions.length > 1) {
      const t2 = actions[1];
      const rj = await req('POST', `/supervisor-ai/actions/${t2.id}/reject`, token, {});
      check('reject 2xx', rj.status === 200 || rj.status === 201, rj.status);
      check('acción quedó rejected', rj.body?.status === 'rejected', rj.body?.status);
    }
  } else {
    console.log('  (skip approve/reject: 0 acciones — no hay findings que las generen)');
  }

  console.log('\n── 11. Mejoras (H2.5): GET /supervisor-ai/opportunities ──');
  await req('POST', '/supervisor-ai/compute', token, {}); // asegura mejoras frescas
  const opps = await req('GET', '/supervisor-ai/opportunities', token);
  check('opportunities 200', opps.status === 200, opps.status);
  const opportunities = opps.body?.rows || [];
  console.log(
    `     mejoras pending=${opportunities.length} | tipos=${[...new Set(opportunities.map((o) => o.action_type))].join(',') || '—'}`,
  );
  if (opportunities.length > 0) {
    check(
      'cada mejora trae kind=opportunity + action_type + title',
      opportunities.every((o) => o.kind === 'opportunity' && o.action_type && o.title),
      opportunities[0],
    );
    check(
      'al menos una mejora con rationale (el por qué)',
      opportunities.some((o) => o.rationale && String(o.rationale).length > 0),
      opportunities.map((o) => o.action_type),
    );
    const actsOpp = await req('GET', '/supervisor-ai/actions?kind=opportunity&status=pending_approval', token);
    check(
      'separación kind: /actions?kind=opportunity == /opportunities',
      (actsOpp.body?.rows || []).length === opportunities.length,
      { actions_kind: (actsOpp.body?.rows || []).length, opportunities: opportunities.length },
    );
    const actsFinding = await req('GET', '/supervisor-ai/actions?kind=finding&status=pending_approval', token);
    check(
      'las acciones de finding NO incluyen opportunities',
      (actsFinding.body?.rows || []).every((a) => a.kind !== 'opportunity'),
      (actsFinding.body?.rows || []).map((a) => a.kind),
    );

    console.log('\n── 12. Ejecutor real (H2.6): aprobar mejora → artefacto in-app ──');
    const opp = opportunities[0];
    const ap = await req('POST', `/supervisor-ai/actions/${opp.id}/approve`, token, {});
    check('approve mejora 2xx', ap.status === 200 || ap.status === 201, ap.status);
    check('mejora quedó executed', ap.body?.status === 'executed', ap.body?.status);
    const result = typeof ap.body?.result === 'string' ? JSON.parse(ap.body.result) : ap.body?.result;
    check(
      'result con efecto REAL (coaching_note | task | set_target)',
      ['coaching_note', 'task', 'set_target'].includes(result?.effect),
      result,
    );
    check('result.reversible === true', result?.reversible === true, result);

    if (result?.effect === 'coaching_note') {
      const notes = await req('GET', '/supervisor-ai/coaching-notes', token);
      check('coaching-notes 200', notes.status === 200, notes.status);
      check(
        'la nota de coaching creada aparece en el endpoint',
        (notes.body?.rows || []).some((n) => n.id === result.coaching_note_id),
        result.coaching_note_id,
      );
      const dbN = await knex('commercial.coaching_notes').where('id', result.coaching_note_id).first();
      check('DB: coaching_note persistida', !!dbN, result.coaching_note_id);
    } else if (result?.effect === 'task') {
      const tasks = await req('GET', '/supervisor-ai/tasks', token);
      check('tasks 200', tasks.status === 200, tasks.status);
      check(
        'la tarea creada aparece en el endpoint',
        (tasks.body?.rows || []).some((t) => t.id === result.task_id),
        result.task_id,
      );
      const dbT = await knex('commercial.supervisor_tasks').where('id', result.task_id).first();
      check('DB: supervisor_task persistida con due_date', !!dbT && !!dbT.due_date, dbT);
    }

    const opps2 = await req('GET', '/supervisor-ai/opportunities', token);
    check(
      'la mejora aprobada ya NO está en pending',
      !(opps2.body?.rows || []).some((o) => o.id === opp.id),
      opp.id,
    );
  } else {
    console.log('  (skip 11/12: 0 mejoras — el motor corrió sin oportunidades con la data actual)');
  }

  console.log('\n── 13. Visión (H2.2): coverage + scan + veredictos ──');
  const cov0 = await req('GET', '/supervisor-ai/vision/coverage', token);
  check('vision/coverage 200', cov0.status === 200, cov0.status);
  check(
    'coverage trae photos_total + analyzed + has_api_key',
    cov0.body &&
      typeof cov0.body.photos_total === 'number' &&
      typeof cov0.body.analyzed === 'number' &&
      typeof cov0.body.has_api_key === 'boolean',
    cov0.body,
  );
  console.log(
    `     fotos_total=${cov0.body?.photos_total} analizadas=${cov0.body?.analyzed} api_key=${cov0.body?.has_api_key}`,
  );

  const scan = await req('POST', '/supervisor-ai/vision/scan', token, { max: 5 });
  check('vision/scan 2xx', scan.status === 200 || scan.status === 201, scan.status);
  check(
    'scan devuelve {scan, vision_findings}',
    scan.body?.scan && typeof scan.body.scan.candidates === 'number' && !!scan.body.vision_findings,
    scan.body,
  );
  const sc = scan.body?.scan || {};
  console.log(
    `     scan: candidates=${sc.candidates} analyzed=${sc.analyzed} errors=${sc.errors} reason=${sc.reason || '—'}`,
  );

  const vlist = await req('GET', '/supervisor-ai/vision?flagged=true', token);
  check('vision list 200', vlist.status === 200, vlist.status);
  check('vision list devuelve rows[]', Array.isArray(vlist.body?.rows), vlist.body);

  if (cov0.body?.has_api_key && ((sc.analyzed || 0) > 0 || (cov0.body?.analyzed || 0) > 0)) {
    const dbV = await knex('commercial.capture_vision').where('tenant_id', T).count('* as n').first();
    check('DB: capture_vision tiene veredictos', Number(dbV.n) > 0, Number(dbV.n));
    const sample = await knex('commercial.capture_vision')
      .where('tenant_id', T)
      .whereNotNull('photo_quality')
      .first();
    check('veredicto trae photo_quality (estructura)', !sample || typeof sample.photo_quality === 'string', sample?.photo_quality);
    console.log('     (ANTHROPIC_API_KEY presente → visión real verificada contra DB)');
  } else {
    console.log('  (skip asserts de veredicto: sin ANTHROPIC_API_KEY o 0 fotos analizadas — pipeline verificado igual)');
  }

  console.log('\n── 14. Fraude / integridad (H2.4): reglas deterministas ──');
  const fraudScan = await req('POST', '/supervisor-ai/fraud/scan', token, {});
  check('fraud/scan 2xx', fraudScan.status === 200 || fraudScan.status === 201, fraudScan.status);
  check(
    'fraud/scan devuelve {open, resolved} numéricos',
    fraudScan.body && typeof fraudScan.body.open === 'number' && typeof fraudScan.body.resolved === 'number',
    fraudScan.body,
  );
  const dbFraud = await knex('commercial.supervisor_findings')
    .where({ tenant_id: T, source: 'fraud' })
    .select('finding_type', 'subject_type', 'status', 'evidence');
  console.log(
    `     fraud open=${fraudScan.body?.open} | en DB source=fraud: ${dbFraud.length} | tipos=${[...new Set(dbFraud.map((f) => f.finding_type))].join(',') || '—'}`,
  );

  // Guardarraíl ADR-020: el fraude se DETECTA pero NO acciona solo (acusar es humano).
  const fraudActions = await knex('commercial.supervisor_actions as a')
    .join('commercial.supervisor_findings as f', 'f.id', 'a.finding_id')
    .where({ 'a.tenant_id': T, 'f.source': 'fraud' })
    .count('* as n')
    .first();
  check('fraude NO genera acción de co-piloto automática (ADR-020)', Number(fraudActions.n) === 0, Number(fraudActions.n));

  if (dbFraud.length > 0) {
    check(
      'todo fraude: finding_type fraud_* + subject collaborator + source=fraud',
      dbFraud.every((f) => /^fraud_/.test(f.finding_type) && f.subject_type === 'collaborator'),
      dbFraud[0],
    );
    const openF = await req('GET', '/supervisor-ai/findings?status=open', token);
    const inTray = (openF.body?.rows || []).filter((x) => /^fraud_/.test(x.finding_type));
    check(
      'los hallazgos de fraude abiertos aparecen en la bandeja',
      inTray.length > 0 || !dbFraud.some((f) => f.status === 'open'),
      { tray: inTray.length, openInDb: dbFraud.filter((f) => f.status === 'open').length },
    );
  } else {
    console.log('  (0 hallazgos de fraude — data limpia en la ventana; pipeline + guardarraíl verificados igual)');
  }

  console.log('\n── 15. Motor multi-señal (H2.3): salud de ejecución explicable ──');
  const cmp = await req('POST', '/supervisor-ai/compute', token, {});
  check('compute devuelve scoring {scored}', cmp.body?.scoring && typeof cmp.body.scoring.scored === 'number', cmp.body?.scoring);
  const ex = await req('GET', '/supervisor-ai/execution-360?subject_type=collaborator&window_days=30', token);
  check('execution-360 200', ex.status === 200, ex.status);
  const parseBd = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const scored = (ex.body?.rows || []).filter((r) => r.exec_score != null);
  console.log(`     colaboradores con exec_score: ${scored.length}/${(ex.body?.rows || []).length}`);
  if (scored.length > 0) {
    check(
      'exec_score en [0,100]',
      scored.every((r) => Number(r.exec_score) >= 0 && Number(r.exec_score) <= 100),
      scored.map((r) => r.exec_score),
    );
    check(
      'cada exec_score trae breakdown.signals[]',
      scored.every((r) => {
        const bd = parseBd(r.exec_score_breakdown);
        return bd && Array.isArray(bd.signals) && bd.signals.length > 0;
      }),
      parseBd(scored[0].exec_score_breakdown),
    );
    const sample = scored[0];
    const bd = parseBd(sample.exec_score_breakdown);
    const sum = (bd.signals || []).reduce((a, s) => a + Number(s.contribution), 0);
    check(
      'breakdown: suma de contribuciones ≈ exec_score (±1)',
      Math.abs(sum - Number(sample.exec_score)) <= 1.0,
      { sum: Math.round(sum * 100) / 100, score: Number(sample.exec_score) },
    );
    check(
      'breakdown ordenado peor→mejor (1ra contribución es la menor)',
      (bd.signals || []).length < 2 || Number(bd.signals[0].contribution) <= Number(bd.signals[bd.signals.length - 1].contribution),
      bd.signals?.map((s) => s.contribution),
    );
    console.log(
      `     ej. ${sample.label}: salud=${sample.exec_score} | más resta=${bd.signals?.[0]?.label} (${bd.signals?.[0]?.contribution})`,
    );
  } else {
    console.log('  (skip asserts de score: 0 colaboradores con datos suficientes — confianza < 0.4)');
  }

  console.log('\n── 16. Venta↔ejecución (H2.7): correlación + cobertura + gate ──');
  const se = await req('GET', '/supervisor-ai/sales-execution', token);
  check('sales-execution 200', se.status === 200, se.status);
  check(
    'trae collaborators[] + stores[] + coverage',
    Array.isArray(se.body?.collaborators) && Array.isArray(se.body?.stores) && !!se.body?.coverage,
    Object.keys(se.body || {}),
  );
  const cov = se.body?.coverage || {};
  check(
    'coverage con métricas + sales_data_mature',
    typeof cov.collaborators_with_sales === 'number' &&
      typeof cov.stores_with_sales === 'number' &&
      typeof cov.sales_data_mature === 'boolean',
    cov,
  );
  console.log(
    `     venta: ${cov.collaborators_with_sales}/${cov.collaborators_total} vendedores · ${cov.stores_with_sales}/${cov.stores_total} tiendas | maduro=${cov.sales_data_mature}`,
  );
  const cmp2 = await req('POST', '/supervisor-ai/compute', token, {});
  const seCompute = cmp2.body?.sales_execution || {};
  if (!cov.sales_data_mature) {
    check(
      'gate: gap DORMIDO por venta inmadura (reason o 0 open)',
      seCompute.reason === 'insufficient_sales_data' || seCompute.open === 0,
      seCompute,
    );
    const gapF = await knex('commercial.supervisor_findings')
      .where({ tenant_id: T, finding_type: 'sales_execution_gap', status: 'open' })
      .count('* as n')
      .first();
    check('no hay sales_execution_gap abiertos (data inmadura, ADR: no juzgar sobre ruido)', Number(gapF.n) === 0, Number(gapF.n));
  } else {
    check('venta madura → gap puede emitir (open numérico)', typeof seCompute.open === 'number', seCompute);
  }

  console.log('\n── 17. Feature Store v2 (H2.1): nivel de ejecución + duración + surtido ──');
  await req('POST', '/supervisor-ai/compute', token, {});
  const ex2 = await req('GET', '/supervisor-ai/execution-360?subject_type=collaborator&window_days=30', token);
  check('execution-360 200', ex2.status === 200, ex2.status);
  const rows2 = ex2.body?.rows || [];
  const withLevel = rows2.filter((r) => r.exec_level_score != null);
  console.log(
    `     con nivel=${withLevel.length}/${rows2.length} | ej. ${withLevel[0]?.label}: nivel=${withLevel[0]?.exec_level_score} min/vis=${withLevel[0]?.avg_visit_min} skus=${withLevel[0]?.avg_skus}`,
  );
  check('hay exec_level_score poblado', withLevel.length > 0, withLevel.length);
  if (withLevel.length > 0) {
    check(
      'exec_level_score en [0,100]',
      withLevel.every((r) => Number(r.exec_level_score) >= 0 && Number(r.exec_level_score) <= 100),
      withLevel.map((r) => r.exec_level_score),
    );
    check(
      'avg_visit_min poblado (>0)',
      withLevel.some((r) => r.avg_visit_min != null && Number(r.avg_visit_min) > 0),
      withLevel.map((r) => r.avg_visit_min),
    );
    check('avg_skus poblado', withLevel.some((r) => r.avg_skus != null), withLevel.map((r) => r.avg_skus));
    const parseBd2 = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
    const withExecSignal = withLevel.filter((r) => {
      const bd = parseBd2(r.exec_score_breakdown);
      return bd?.signals?.some((s) => s.key === 'exec_level');
    });
    check('el score de salud (H2.3) ahora incorpora la señal exec_level', withExecSignal.length > 0, withExecSignal.length);
  }

  console.log('\n── 18. Snapshot t0 (histórico append-only) ──');
  const cmp3 = await req('POST', '/supervisor-ai/compute', token, {});
  check('compute devuelve snapshot {snapshotted}', cmp3.body?.snapshot && typeof cmp3.body.snapshot.snapshotted === 'number', cmp3.body?.snapshot);
  const todaySql = "snapshot_date = (now() AT TIME ZONE 'America/Mexico_City')::date";
  const dbSnap = await knex('commercial.execution_360_snapshots').where('tenant_id', T).whereRaw(todaySql).count('* as n').first();
  check('snapshots de HOY persistidos', Number(dbSnap.n) > 0, Number(dbSnap.n));
  await req('POST', '/supervisor-ai/compute', token, {}); // re-compute mismo día
  const dbSnap2 = await knex('commercial.execution_360_snapshots').where('tenant_id', T).whereRaw(todaySql).count('* as n').first();
  check('snapshot idempotente por día (re-compute NO duplica)', Number(dbSnap2.n) === Number(dbSnap.n), { first: Number(dbSnap.n), second: Number(dbSnap2.n) });
  console.log(`     snapshots hoy=${dbSnap.n} (estable tras re-compute=${dbSnap2.n})`);

  console.log('\n── 19. Loop al campo (Batch 2 / #1): endpoints field + dismiss propaga ──');
  const myTasks = await req('GET', '/supervisor-ai/field/my-tasks', token);
  check('field/my-tasks 200 (self-scoped)', myTasks.status === 200, myTasks.status);
  check('my-tasks shape {rows,total}', Array.isArray(myTasks.body?.rows) && typeof myTasks.body?.total === 'number', myTasks.body);
  const myCoach = await req('GET', '/supervisor-ai/field/my-coaching', token);
  check('field/my-coaching 200 (self-scoped)', myCoach.status === 200, myCoach.status);
  check('my-coaching shape {rows,total}', Array.isArray(myCoach.body?.rows), myCoach.body);

  // Propagación del dismiss: aprobar coaching → nota; descartar su finding → nota soft-borrada.
  await req('POST', '/supervisor-ai/compute', token, {});
  const actsAll = await req('GET', '/supervisor-ai/actions?status=pending_approval', token);
  const coachAct = (actsAll.body?.rows || []).find(
    (a) => ['coaching', 'coaching_focus', 'replicate_best'].includes(a.action_type) && a.finding_id,
  );
  if (coachAct) {
    const ap = await req('POST', `/supervisor-ai/actions/${coachAct.id}/approve`, token, {});
    const result = typeof ap.body?.result === 'string' ? JSON.parse(ap.body.result) : ap.body?.result;
    const noteId = result?.coaching_note_id;
    if (noteId) {
      const before = await knex('commercial.coaching_notes').where('id', noteId).first();
      check('nota de coaching creada y viva', !!before && before.deleted_at == null, before?.deleted_at);
      const rv = await req('POST', `/supervisor-ai/findings/${coachAct.finding_id}/review`, token, { status: 'dismissed' });
      check('dismiss del finding 2xx', rv.status === 200 || rv.status === 201, rv.status);
      const after = await knex('commercial.coaching_notes').where('id', noteId).first();
      check('dismiss PROPAGÓ: la nota quedó soft-borrada (no huérfana en el campo)', !!after && after.deleted_at != null, after?.deleted_at);
    } else {
      console.log('  (skip propagación: approve no devolvió coaching_note_id)');
    }
  } else {
    console.log('  (skip propagación: sin acción de coaching pendiente — estado consumido por corridas previas)');
  }

  console.log('\n── 20. Aprendizaje L2 (ADR-021): auto-calibración de reglas ──');
  const recomp = await req('POST', '/supervisor-ai/learning/recompute', token, {});
  check('learning/recompute 2xx', recomp.status === 200 || recomp.status === 201, recomp.status);
  check(
    'recompute devuelve {rules, suppressed} numéricos',
    recomp.body && typeof recomp.body.rules === 'number' && typeof recomp.body.suppressed === 'number',
    recomp.body,
  );

  const lr2 = await req('GET', '/supervisor-ai/learning/rules', token);
  check('learning/rules 200', lr2.status === 200, lr2.status);
  const ruleRows = lr2.body?.rows || [];
  check('rules shape {rows,total}', Array.isArray(ruleRows) && typeof lr2.body?.total === 'number', lr2.body);
  if (ruleRows.length > 0) {
    check(
      'cada regla trae finding_type+source+reviewed_total+effective_suppressed',
      ruleRows.every(
        (r) =>
          r.finding_type &&
          r.source &&
          Number.isFinite(Number(r.reviewed_total)) &&
          typeof r.effective_suppressed === 'boolean',
      ),
      ruleRows[0],
    );
    console.log(
      `     reglas=${ruleRows.length} | ` +
        ruleRows
          .map((r) => `${r.finding_type}:${r.source} p=${r.precision ?? 'n/a'} jz=${r.reviewed_total}${r.effective_suppressed ? ' [supr]' : ''}`)
          .join(' · '),
    );
  }

  // Funcional: descartar un finding open → el scorecard lo cuenta como juzgado.
  const openF = await req('GET', '/supervisor-ai/findings?status=open', token);
  const victim = (openF.body?.rows || []).find((x) => x.source === 'engine');
  if (victim) {
    await req('POST', `/supervisor-ai/findings/${victim.id}/review`, token, { status: 'dismissed' });
    await req('POST', '/supervisor-ai/learning/recompute', token, {});
    const lr3 = await req('GET', '/supervisor-ai/learning/rules', token);
    const stat = (lr3.body?.rows || []).find((r) => r.finding_type === victim.finding_type && r.source === 'engine');
    check(
      'el dismiss se refleja en el scorecard (reviewed_total ≥ 1, n_dismissed ≥ 1)',
      !!stat && Number(stat.reviewed_total) >= 1 && Number(stat.n_dismissed) >= 1,
      stat,
    );
  } else {
    console.log('  (skip funcional dismiss→scorecard: sin finding engine open — estado consumido por corridas previas)');
  }

  // Override humano: pin 'suppressed' → el motor deja de emitir esa regla (y conserva el pin).
  const engRules = ruleRows.filter((r) => r.source === 'engine');
  const pinType = engRules[0]?.finding_type || victim?.finding_type;
  if (pinType) {
    const ov = await req('POST', `/supervisor-ai/learning/rules/${pinType}/override`, token, { override: 'suppressed' });
    check('override suppressed 2xx', ov.status === 200 || ov.status === 201, ov.status);
    const lrOv = await req('GET', '/supervisor-ai/learning/rules', token);
    const ovStat = (lrOv.body?.rows || []).find((r) => r.finding_type === pinType && r.source === 'engine');
    check('override → effective_suppressed=true', ovStat?.effective_suppressed === true, ovStat);

    // El motor respeta la supresión: tras recomputar, 0 findings open de ese tipo.
    await req('POST', '/supervisor-ai/compute', token, {});
    const openAfter = await req('GET', '/supervisor-ai/findings?status=open', token);
    check(
      'motor respeta override: 0 findings open del tipo suprimido',
      !(openAfter.body?.rows || []).some((x) => x.finding_type === pinType && x.source === 'engine'),
      (openAfter.body?.rows || []).filter((x) => x.finding_type === pinType).length,
    );

    // El learner NO pisa el pin humano.
    await req('POST', '/supervisor-ai/learning/recompute', token, {});
    const lrKeep = await req('GET', '/supervisor-ai/learning/rules', token);
    const keepStat = (lrKeep.body?.rows || []).find((r) => r.finding_type === pinType && r.source === 'engine');
    check('recompute conserva el pin humano (manual_override=suppressed)', keepStat?.manual_override === 'suppressed', keepStat?.manual_override);

    // Cleanup: quitar el pin para no afectar re-runs + regenerar el tipo restaurado.
    const un = await req('POST', `/supervisor-ai/learning/rules/${pinType}/override`, token, { override: null });
    check('quitar override (cleanup) 2xx', un.status === 200 || un.status === 201, un.status);
    await req('POST', '/supervisor-ai/compute', token, {});
  } else {
    console.log('  (skip override: sin reglas engine en el scorecard todavía)');
  }

  console.log('\n── 21. Aprendizaje L1 (ADR-021): baselines por sujeto + z-score self_anomaly ──');
  const cmpB = await req('POST', '/supervisor-ai/compute', token, {});
  check(
    'compute devuelve {baselines: {baselines, floor_met}} numéricos',
    cmpB.body?.baselines &&
      typeof cmpB.body.baselines.baselines === 'number' &&
      typeof cmpB.body.baselines.floor_met === 'number',
    cmpB.body?.baselines,
  );
  const bl = await req('GET', '/supervisor-ai/learning/baselines', token);
  check('learning/baselines 200', bl.status === 200, bl.status);
  check('baselines shape {rows,total}', Array.isArray(bl.body?.rows) && typeof bl.body?.total === 'number', bl.body);
  console.log(`     baselines reales=${bl.body?.total ?? 0} (floor_met requiere ≥7 snapshots/sujeto — gate por calendario)`);

  // Verificación REAL del aprendizaje: histórico sintético → el z-score DEBE disparar
  // self_anomaly (cae vs SU propia normal, no vs umbral global). Subject de prueba + cleanup.
  const SX = '0000000a-0000-0000-0000-00000000ba51';
  const cleanupL1 = async () => {
    const actIds = (await knex('commercial.supervisor_actions').where({ tenant_id: T, subject_id: SX }).select('id')).map((a) => a.id);
    if (actIds.length) await knex('commercial.supervisor_tasks').whereIn('action_id', actIds).del();
    await knex('commercial.coaching_notes').where({ tenant_id: T, collaborator_id: SX }).del();
    await knex('commercial.supervisor_actions').where({ tenant_id: T, subject_id: SX }).del();
    await knex('commercial.supervisor_findings').where({ tenant_id: T, subject_id: SX }).del();
    await knex('commercial.execution_baselines').where({ tenant_id: T, subject_id: SX }).del();
    await knex('commercial.execution_360_snapshots').where({ tenant_id: T, subject_id: SX }).del();
    await knex('commercial.execution_360').where({ tenant_id: T, subject_id: SX }).del();
  };
  await cleanupL1(); // por si una corrida previa abortó antes del cleanup
  const hist = [85, 84, 86, 85, 83, 87, 85, 84]; // 8 días "normales" altos (~85) con leve varianza
  const snaps = hist.map((v, i) => ({
    tenant_id: T,
    snapshot_date: knex.raw(`(now() AT TIME ZONE 'America/Mexico_City')::date - ${i + 1}`),
    subject_type: 'collaborator',
    subject_id: SX,
    window_days: 30,
    label: '__horus_l1_test__',
    avg_score: v,
    visits_done: 6,
  }));
  await knex('commercial.execution_360_snapshots').insert(snaps);
  await knex('commercial.execution_360')
    .insert({
      tenant_id: T,
      subject_type: 'collaborator',
      subject_id: SX,
      window_days: 30,
      label: '__horus_l1_test__',
      visits_done: 6,
      avg_score: 30, // HOY muy por debajo de su normal (~85)
    })
    .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days'])
    .merge();
  await req('POST', '/supervisor-ai/compute', token, {}); // recomputa baselines (antes) + findings
  const baseSX = await knex('commercial.execution_baselines')
    .where({ tenant_id: T, subject_id: SX, metric: 'avg_score', window_days: 30 })
    .first();
  check(
    'baseline del sujeto sintético floor_met (n≥7)',
    !!baseSX && baseSX.floor_met === true && Number(baseSX.n_obs) >= 7,
    baseSX ? { n: baseSX.n_obs, floor: baseSX.floor_met, mean: baseSX.mean } : 'sin baseline',
  );
  const anomaly = await knex('commercial.supervisor_findings')
    .where({ tenant_id: T, subject_id: SX, finding_type: 'self_anomaly' })
    .first();
  check(
    'el z-score DISPARÓ self_anomaly (cae vs SU baseline, invisible al umbral global)',
    !!anomaly,
    anomaly ? { sev: anomaly.severity, score: anomaly.score } : 'sin self_anomaly',
  );
  if (anomaly) {
    const ev = typeof anomaly.evidence === 'string' ? JSON.parse(anomaly.evidence) : anomaly.evidence;
    check(
      'evidencia explicable (baseline_mean + z + current=30)',
      ev && ev.baseline_mean != null && ev.z != null && Number(ev.current) === 30,
      ev,
    );
  }
  await cleanupL1();
  const goneSX = await knex('commercial.execution_360').where({ tenant_id: T, subject_id: SX }).first();
  check('cleanup L1 OK (sin datos sintéticos residuales)', !goneSX, goneSX);

  console.log('\n── 22. Horus 360 · K1: desglose por concepto + ubicación + weak_concept ──');
  await req('POST', '/supervisor-ai/compute', token, {});
  const exK = await req('GET', '/supervisor-ai/execution-360?subject_type=collaborator&window_days=30', token);
  check('execution-360 200', exK.status === 200, exK.status);
  const rowsK = exK.body?.rows || [];
  const withConcept = rowsK.filter((r) => r.by_concept && Object.keys(r.by_concept).length > 0);
  console.log(`     colaboradores con desglose por concepto=${withConcept.length}/${rowsK.length}`);
  check('hay rows con by_concept poblado (dato real ~93%)', withConcept.length > 0, withConcept.length);
  if (withConcept.length > 0) {
    const c = Object.values(withConcept[0].by_concept)[0];
    check('cada concepto trae {n, level_avg}', !!c && typeof c.n === 'number' && 'level_avg' in c, c);
  }

  // Verificación REAL de weak_concept: inyecto un concepto flojo → el motor lo detecta.
  const SX3 = '0000000a-0000-0000-0000-00000000ba53';
  const cleanK1 = async () => {
    await knex('commercial.supervisor_findings').where({ tenant_id: T, subject_id: SX3 }).del();
    await knex('commercial.execution_360_snapshots').where({ tenant_id: T, subject_id: SX3 }).del();
    await knex('commercial.execution_baselines').where({ tenant_id: T, subject_id: SX3 }).del();
    await knex('commercial.execution_360').where({ tenant_id: T, subject_id: SX3 }).del();
  };
  await cleanK1();
  await knex('commercial.execution_360')
    .insert({
      tenant_id: T,
      subject_type: 'collaborator',
      subject_id: SX3,
      window_days: 30,
      label: '__horus_k1_test__',
      visits_done: 6,
      avg_score: 70,
      exec_level_score: 70, // su nivel general
      by_concept: JSON.stringify({
        'c-test': { label: '__cabecera_test__', n: 5, level_avg: 20, own_share_pct: 50, photo_pct: 40 },
      }),
    })
    .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days'])
    .merge();
  await req('POST', '/supervisor-ai/compute', token, {});
  const wc = await knex('commercial.supervisor_findings')
    .where({ tenant_id: T, subject_id: SX3, finding_type: 'weak_concept' })
    .first();
  check('weak_concept disparó sobre el concepto flojo inyectado (20 vs 70)', !!wc, wc ? { sev: wc.severity, score: wc.score } : 'sin weak_concept');
  if (wc) {
    const ev = typeof wc.evidence === 'string' ? JSON.parse(wc.evidence) : wc.evidence;
    check(
      'evidencia explicable (concept + concept_level=20 + overall_level=70)',
      ev && ev.concept && Number(ev.concept_level) === 20 && Number(ev.overall_level) === 70,
      ev,
    );
  }
  await cleanK1();
  const goneK1 = await knex('commercial.execution_360').where({ tenant_id: T, subject_id: SX3 }).first();
  check('cleanup K1 OK (sin datos sintéticos residuales)', !goneK1, goneK1);

  console.log('\n── 23. Horus 360 · K4: adherencia al planograma + planogram_gap ──');
  await req('POST', '/supervisor-ai/compute', token, {});
  const exP = await req('GET', '/supervisor-ai/execution-360?subject_type=collaborator&window_days=30', token);
  const rowsP = exP.body?.rows || [];
  const withPlano = rowsP.filter((r) => r.planogram_total != null && r.planogram_present != null);
  console.log(`     sujetos con planograma medido=${withPlano.length}/${rowsP.length} · total planograma=${withPlano[0]?.planogram_total ?? '?'}`);
  check('feature planograma poblado (present + total numéricos)', withPlano.length > 0, withPlano.length);
  if (withPlano.length > 0) {
    check('planogram_total > 0 (planograma cargado)', Number(withPlano[0].planogram_total) > 0, withPlano[0].planogram_total);
  }

  // Verificación REAL de planogram_gap (peer-relativo): inyecto pares ALTOS que dominan
  // la mediana + 1 tienda BAJA → debe dispararse sobre la baja. Cleanup completo.
  const mk = (i) => `0000000a-0000-0000-0000-${String(710000000000 + i).padStart(12, '0')}`;
  const realN = Number(
    (
      await knex('commercial.execution_360')
        .where({ tenant_id: T, subject_type: 'store', window_days: 30 })
        .whereNotNull('planogram_present')
        .where('visits_done', '>=', 3)
        .count('* as n')
        .first()
    ).n,
  );
  const nHigh = realN + 5; // domina la mediana de pares reales (suelen tener present bajo)
  const lowId = mk(9999);
  const synthIds = [lowId];
  for (let i = 0; i < nHigh; i++) synthIds.push(mk(i));
  const cleanK4 = async () => {
    await knex('commercial.supervisor_findings').where('tenant_id', T).whereIn('subject_id', synthIds).del();
    await knex('commercial.execution_360_snapshots').where('tenant_id', T).whereIn('subject_id', synthIds).del();
    await knex('commercial.execution_360').where('tenant_id', T).whereIn('subject_id', synthIds).del();
  };
  await cleanK4();
  const synthRows = synthIds.map((id) => ({
    tenant_id: T,
    subject_type: 'store',
    subject_id: id,
    window_days: 30,
    label: '__k4_test__',
    visits_done: 6,
    planogram_present: id === lowId ? 2 : 40,
    planogram_total: 852,
  }));
  await knex('commercial.execution_360')
    .insert(synthRows)
    .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days'])
    .merge();
  await req('POST', '/supervisor-ai/compute', token, {});
  const pg = await knex('commercial.supervisor_findings')
    .where({ tenant_id: T, subject_id: lowId, finding_type: 'planogram_gap' })
    .first();
  check('planogram_gap disparó sobre la tienda baja (2 vs mediana de pares)', !!pg, pg ? { sev: pg.severity, score: pg.score } : 'sin planogram_gap');
  if (pg) {
    const ev = typeof pg.evidence === 'string' ? JSON.parse(pg.evidence) : pg.evidence;
    check('evidencia explicable (present=2 + peer_median ≥ 4)', ev && Number(ev.planogram_present) === 2 && Number(ev.peer_median) >= 4, ev);
  }
  // El par ALTO (present 40) NO debe dispararse.
  const pgHigh = await knex('commercial.supervisor_findings')
    .where({ tenant_id: T, subject_id: mk(0), finding_type: 'planogram_gap' })
    .first();
  check('el par alto (present 40) NO dispara planogram_gap', !pgHigh, pgHigh ? pgHigh.id : 'ok');
  await cleanK4();
  const goneK4 = await knex('commercial.execution_360').where('tenant_id', T).whereIn('subject_id', synthIds).first();
  check('cleanup K4 OK (sin tiendas sintéticas residuales)', !goneK4, goneK4);

  console.log('\n── 24. Horus 360 · K6: roll-ups por zona + supervisor ──');
  await req('POST', '/supervisor-ai/compute', token, {});
  const exZ = await req('GET', '/supervisor-ai/execution-360?subject_type=zone&window_days=30', token);
  check('execution-360 zone 200 (DTO acepta zone)', exZ.status === 200, exZ.status);
  const zoneRows = exZ.body?.rows || [];
  console.log(`     zonas con roll-up=${zoneRows.length}`);
  check('hay subject_type=zone (roll-up org)', zoneRows.length > 0, zoneRows.length);
  if (zoneRows.length > 0) {
    check('zona trae métricas core (visits_done numérico)', typeof zoneRows[0].visits_done === 'number', zoneRows[0]);
  }
  const exS = await req('GET', '/supervisor-ai/execution-360?subject_type=supervisor&window_days=30', token);
  check('execution-360 supervisor 200', exS.status === 200, exS.status);
  check('hay subject_type=supervisor (roll-up por equipo)', (exS.body?.rows || []).length > 0, (exS.body?.rows || []).length);

  // Verificación REAL: low_score aplica a roll-up org. Inyecto una zona con score bajo → dispara.
  const ZX = '0000000a-0000-0000-0000-00000000ba60';
  const cleanK6 = async () => {
    await knex('commercial.supervisor_findings').where({ tenant_id: T, subject_id: ZX }).del();
    await knex('commercial.execution_360_snapshots').where({ tenant_id: T, subject_id: ZX }).del();
    await knex('commercial.execution_360').where({ tenant_id: T, subject_id: ZX }).del();
  };
  await cleanK6();
  await knex('commercial.execution_360')
    .insert({
      tenant_id: T,
      subject_type: 'zone',
      subject_id: ZX,
      window_days: 30,
      label: '__zona_test__',
      visits_done: 5,
      avg_score: 10,
    })
    .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days'])
    .merge();
  await req('POST', '/supervisor-ai/compute', token, {});
  const ls = await knex('commercial.supervisor_findings')
    .where({ tenant_id: T, subject_id: ZX, finding_type: 'low_score' })
    .first();
  check(
    'low_score disparó sobre la zona de score bajo (10 < 25) con subject_type=zone',
    !!ls && ls.subject_type === 'zone',
    ls ? { sev: ls.severity, st: ls.subject_type } : 'sin low_score',
  );
  await cleanK6();
  const goneK6 = await knex('commercial.execution_360').where({ tenant_id: T, subject_id: ZX }).first();
  check('cleanup K6 OK (sin zona sintética residual)', !goneK6, goneK6);

  console.log('\n── 25. Horus 360 · K3: calidad de posición (pesos oficiales) + weak_position ──');
  await req('POST', '/supervisor-ai/compute', token, {});
  const exPos = await req('GET', '/supervisor-ai/execution-360?subject_type=collaborator&window_days=30', token);
  const rowsPos = exPos.body?.rows || [];
  const withPos = rowsPos.filter((r) => r.position_quality != null);
  console.log(`     con position_quality=${withPos.length}/${rowsPos.length}${withPos[0] ? ' · ej. ' + withPos[0].position_quality + '/100' : ''}`);
  check('feature position_quality poblado (pesos oficiales de ubicación)', withPos.length > 0, withPos.length);
  if (withPos.length > 0) {
    check(
      'position_quality en [0,100]',
      withPos.every((r) => Number(r.position_quality) >= 0 && Number(r.position_quality) <= 100),
      withPos.map((r) => r.position_quality),
    );
  }

  // Verificación REAL de weak_position: inyecto un sujeto con posición débil → dispara.
  const PX = '0000000a-0000-0000-0000-00000000ba70';
  const cleanK3 = async () => {
    await knex('commercial.supervisor_findings').where({ tenant_id: T, subject_id: PX }).del();
    await knex('commercial.execution_360_snapshots').where({ tenant_id: T, subject_id: PX }).del();
    await knex('commercial.execution_360').where({ tenant_id: T, subject_id: PX }).del();
  };
  await cleanK3();
  await knex('commercial.execution_360')
    .insert({
      tenant_id: T,
      subject_type: 'collaborator',
      subject_id: PX,
      window_days: 30,
      label: '__pos_test__',
      visits_done: 5,
      position_quality: 15, // mayormente anaquel/detrás
    })
    .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days'])
    .merge();
  await req('POST', '/supervisor-ai/compute', token, {});
  const wp = await knex('commercial.supervisor_findings')
    .where({ tenant_id: T, subject_id: PX, finding_type: 'weak_position' })
    .first();
  check('weak_position disparó sobre posición débil (15 < 35)', !!wp, wp ? { sev: wp.severity, score: wp.score } : 'sin weak_position');
  if (wp) {
    const ev = typeof wp.evidence === 'string' ? JSON.parse(wp.evidence) : wp.evidence;
    check('evidencia explicable (position_quality=15)', ev && Number(ev.position_quality) === 15, ev);
  }
  await cleanK3();
  const goneK3 = await knex('commercial.execution_360').where({ tenant_id: T, subject_id: PX }).first();
  check('cleanup K3 OK (sin sujeto sintético residual)', !goneK3, goneK3);

  console.log('\n── 26. Horus 360 · K5: tiempo muerto (idle) + idle_anomaly ──');
  await req('POST', '/supervisor-ai/compute', token, {});
  const exI = await req('GET', '/supervisor-ai/execution-360?subject_type=collaborator&window_days=30', token);
  check('execution-360 collaborator 200 (idle computado sin crashear)', exI.status === 200, exI.status);
  const rowsI = exI.body?.rows || [];
  const withIdle = rowsI.filter((r) => r.idle_min_avg != null);
  console.log(`     colaboradores con idle medido=${withIdle.length}/${rowsI.length} (requiere multi-captura/día)`);
  check(
    'idle_min_avg es número o null en cada row',
    rowsI.every((r) => r.idle_min_avg == null || Number.isFinite(Number(r.idle_min_avg))),
    rowsI[0],
  );

  // Verificación REAL de idle_anomaly: inyecto un colaborador con idle alto → dispara.
  const IX = '0000000a-0000-0000-0000-00000000ba80';
  const cleanK5 = async () => {
    await knex('commercial.supervisor_findings').where({ tenant_id: T, subject_id: IX }).del();
    await knex('commercial.execution_360_snapshots').where({ tenant_id: T, subject_id: IX }).del();
    await knex('commercial.execution_360').where({ tenant_id: T, subject_id: IX }).del();
  };
  await cleanK5();
  await knex('commercial.execution_360')
    .insert({
      tenant_id: T,
      subject_type: 'collaborator',
      subject_id: IX,
      window_days: 30,
      label: '__idle_test__',
      visits_done: 5,
      idle_min_avg: 200, // ~3.3h promedio entre visitas
    })
    .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days'])
    .merge();
  await req('POST', '/supervisor-ai/compute', token, {});
  const ia = await knex('commercial.supervisor_findings')
    .where({ tenant_id: T, subject_id: IX, finding_type: 'idle_anomaly' })
    .first();
  check('idle_anomaly disparó sobre idle alto (200 > 90)', !!ia, ia ? { sev: ia.severity, score: ia.score } : 'sin idle_anomaly');
  if (ia) {
    const ev = typeof ia.evidence === 'string' ? JSON.parse(ia.evidence) : ia.evidence;
    check('evidencia explicable (idle_min_avg=200)', ev && Number(ev.idle_min_avg) === 200, ev);
  }
  await cleanK5();
  const goneK5 = await knex('commercial.execution_360').where({ tenant_id: T, subject_id: IX }).first();
  check('cleanup K5 OK (sin sujeto sintético residual)', !goneK5, goneK5);

  console.log('\n── 27. Horus.R · R1: diagnóstico de causa raíz (correlación de síntomas) ──');
  const DX = '0000000a-0000-0000-0000-00000000ba90'; // diagnosticado: 2 síntomas
  const DY = '0000000a-0000-0000-0000-00000000ba91'; // atómico: 1 síntoma
  const cleanR1 = async () => {
    for (const id of [DX, DY]) {
      await knex('commercial.supervisor_diagnoses').where({ tenant_id: T, subject_id: id }).del();
      await knex('commercial.supervisor_actions').where({ tenant_id: T, subject_id: id }).del();
      await knex('commercial.supervisor_findings').where({ tenant_id: T, subject_id: id }).del();
      await knex('commercial.execution_360_snapshots').where({ tenant_id: T, subject_id: id }).del();
      await knex('commercial.execution_360').where({ tenant_id: T, subject_id: id }).del();
    }
  };
  await cleanR1();
  // DX: score bajo (10<25 → low_score) + posición floja (15<35 → weak_position) = 2 síntomas.
  // DY: solo score bajo = 1 síntoma (debe quedar atómico, sin diagnóstico).
  await knex('commercial.execution_360')
    .insert([
      { tenant_id: T, subject_type: 'collaborator', subject_id: DX, window_days: 30, label: '__r1_diag_test__', visits_done: 5, avg_score: 10, position_quality: 15 },
      { tenant_id: T, subject_type: 'collaborator', subject_id: DY, window_days: 30, label: '__r1_atomic_test__', visits_done: 5, avg_score: 10 },
    ])
    .onConflict(['tenant_id', 'subject_type', 'subject_id', 'window_days'])
    .merge();
  await req('POST', '/supervisor-ai/compute', token, {});

  // El sujeto con 2 síntomas → UN diagnóstico que CORRELACIONA low_score + weak_position.
  const diag = await knex('commercial.supervisor_diagnoses')
    .where({ tenant_id: T, subject_id: DX, root_cause: 'execution_quality_decline' })
    .first();
  check(
    'diagnóstico execution_quality_decline disparó (correlaciona low_score + weak_position)',
    !!diag,
    diag ? { sev: diag.severity, conf: diag.confidence } : 'sin diagnóstico',
  );
  if (diag) {
    const fids = typeof diag.finding_ids === 'string' ? JSON.parse(diag.finding_ids) : diag.finding_ids;
    check('linkea ≥2 findings (los 2 síntomas)', Array.isArray(fids) && fids.length >= 2, fids);
    check(
      'confianza poblada en (0,1]',
      diag.confidence != null && Number(diag.confidence) > 0 && Number(diag.confidence) <= 1,
      diag.confidence,
    );
    check('severidad = critical (hereda del síntoma más grave)', diag.severity === 'critical', diag.severity);
    const ev = typeof diag.evidence === 'string' ? JSON.parse(diag.evidence) : diag.evidence;
    check(
      'evidence trae action_hint=coaching_focus + symptoms (≥2 frases)',
      ev && ev.action_hint === 'coaching_focus' && Array.isArray(ev.symptoms) && ev.symptoms.length >= 2,
      ev,
    );
  }

  // El sujeto con 1 solo síntoma queda ATÓMICO: NO genera diagnóstico (el valor de R1 es correlacionar).
  const diagAtomic = await knex('commercial.supervisor_diagnoses').where({ tenant_id: T, subject_id: DY }).first();
  check('1 síntoma aislado NO genera diagnóstico (queda atómico)', !diagAtomic, diagAtomic ? diagAtomic.root_cause : 'ok');

  // Endpoint GET /diagnoses lo lista (default open).
  const dl = await req('GET', '/supervisor-ai/diagnoses', token);
  check('GET /diagnoses 200', dl.status === 200, dl.status);
  check('el diagnóstico aparece en GET /diagnoses', (dl.body?.rows || []).some((r) => r.subject_id === DX), (dl.body?.rows || []).length);

  // Feedback humano: descartar → NO se reabre al recomputar (respeta la decisión humana).
  if (diag) {
    const rv = await req('POST', `/supervisor-ai/diagnoses/${diag.id}/review`, token, { status: 'dismissed' });
    check('review dismiss 2xx', rv.status === 200 || rv.status === 201, rv.status);
    await req('POST', '/supervisor-ai/compute', token, {});
    const afterRv = await knex('commercial.supervisor_diagnoses').where({ id: diag.id }).first();
    check(
      'diagnóstico descartado NO se reabre al recomputar (respeta decisión humana)',
      afterRv && afterRv.status === 'dismissed',
      afterRv ? afterRv.status : 'desaparecido',
    );
  }

  await cleanR1();
  const goneR1 = await knex('commercial.supervisor_diagnoses').where({ tenant_id: T }).whereIn('subject_id', [DX, DY]).first();
  check('cleanup R1 OK (sin diagnósticos sintéticos residuales)', !goneR1, goneR1);

  console.log(`\n══ Resultado: ${pass} OK, ${fail} FAIL ══`);
  if (fail) console.log('FALLOS:', failures.join(', '));
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e.stack || e.message);
  process.exit(1);
});
