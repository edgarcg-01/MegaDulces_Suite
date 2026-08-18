/* eslint-disable no-console */
/**
 * COMM-P0 — Trabajos largos de Finanzas: 202 + WS `finance_job` + escape `?sync=true`.
 *
 * Qué protege: `location /api/` de nginx no define `proxy_read_timeout` → rige el
 * default de 60 s. La conciliación, el import del workbook, el reclasificado y los
 * motores de Maat corrían síncronos y al pasarse devolvían **504 con el trabajo a
 * medias**. Ahora el endpoint acusa 202 y el resultado llega por WS.
 *
 * Verifica:
 *   1. POST /finance/bank/match             → 202 + { job_id, queued, name, label }
 *   2. WS /bancos recibe `finance_job` running y luego done|error del MISMO job_id
 *   3. GET /finance/jobs/:id                → estado + result del trabajo
 *   4. GET /finance/jobs                    → el trabajo aparece en el listado
 *   5. POST /finance/bank/match?sync=true   → 200/201 con el resultado INLINE (CLI/smokes)
 *   6. POST /finance/maat/findings/scan     → 202 (mismo contrato en el motor de Maat)
 *   7. GET /finance/jobs/<uuid inexistente> → 404
 *   8. COMM.7 — el canal WS de Finanzas NO admite a cualquier usuario del tenant:
 *      un usuario del portal B2B (customer_b2b, sin permisos de Finanzas) recibe
 *      `auth_error: forbidden` en vez de escuchar el libro y los resultados de import.
 *
 * Requiere API arriba (FINANCE_JOBS_TEST_PORT, default 3334) con ENABLE_MULTITENANT=true.
 * No escribe nada nuevo: `match` es idempotente (recalcula el matching del periodo).
 */

const { io } = require('socket.io-client');
const PORT = process.env.FINANCE_JOBS_TEST_PORT || 3334;
const BASE = `http://localhost:${PORT}/api`;
const WS_BASE = `http://localhost:${PORT}`;

async function http(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let pass = 0, fail = 0;
function check(name, cond, det) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Socket al canal WS de Finanzas (namespace `/bancos`), juntando los `finance_job`. */
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const socket = io(`${WS_BASE}/bancos`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    const jobs = [];
    socket.on('finance_job', (e) => jobs.push(e));
    socket.on('connect', () => resolve({ socket, jobs }));
    socket.on('connect_error', (e) => reject(e));
    socket.on('auth_error', (e) => reject(new Error('auth_error: ' + JSON.stringify(e))));
    setTimeout(() => reject(new Error('connection timeout')), 5000);
  });
}

/**
 * Conecta esperando que el gateway RECHACE (gate de permisos de COMM.7) y devuelve
 * el motivo. 'ACEPTADO' significa que el gate no está haciendo su trabajo.
 */
function expectReject(token) {
  return new Promise((resolve) => {
    const socket = io(`${WS_BASE}/bancos`, {
      path: '/reports/socket.io', auth: { token }, transports: ['websocket'], reconnection: false, timeout: 5000,
    });
    let reason = null;
    socket.on('auth_error', (e) => { reason = e && e.reason ? e.reason : 'auth_error'; });
    socket.on('disconnect', () => { socket.removeAllListeners(); resolve(reason || 'disconnected'); });
    socket.on('connect_error', () => resolve('connect_error'));
    setTimeout(() => {
      const r = reason || (socket.connected ? 'ACEPTADO' : 'timeout');
      socket.disconnect();
      resolve(r);
    }, 4000);
  });
}

/** Espera hasta `ms` a que aparezca un evento terminal del job. */
async function waitFinal(jobs, jobId, ms = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ev = jobs.find((j) => j.job_id === jobId && (j.status === 'done' || j.status === 'error'));
    if (ev) return ev;
    await sleep(500);
  }
  return null;
}

(async () => {
  const login = await http('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = login.body?.access_token;
  check('login OK', !!token, `status=${login.status}`);
  if (!token) process.exit(1);

  const periods = await http('GET', '/finance/bank/periods', null, token);
  const period = Array.isArray(periods.body) ? (periods.body[0]?.period || periods.body[0]) : null;
  check('hay al menos un periodo cargado', !!period, `periods=${JSON.stringify(periods.body)?.slice(0, 120)}`);
  if (!period) { console.log('\n⚠ sin periodos en finance.bank_statements: no hay nada que conciliar. Cargá enero y repetí.'); process.exit(1); }
  console.log(`\n── periodo de prueba: ${period} ──`);

  const ws = await connectWs(token);
  check('WS /bancos conectado', !!ws.socket.connected);

  // ── 1. match asíncrono → 202 + acuse ──
  console.log('\n── 1. POST /finance/bank/match (async) ──');
  const accepted = await http('POST', '/finance/bank/match', { period }, token);
  check('responde 202 (no 200)', accepted.status === 202, `status=${accepted.status}`);
  check('trae job_id', !!accepted.body?.job_id, JSON.stringify(accepted.body)?.slice(0, 160));
  check('queued=true', accepted.body?.queued === true);
  check('name=bank-match', accepted.body?.name === 'bank-match', `name=${accepted.body?.name}`);
  check('label habla del periodo', String(accepted.body?.label || '').includes(period), `label=${accepted.body?.label}`);
  const jobId = accepted.body?.job_id;

  // ── 2. WS: running y después done ──
  console.log('\n── 2. WS finance_job ──');
  const running = ws.jobs.find((j) => j.job_id === jobId && j.status === 'running');
  check('llegó `running` por WS', !!running, `eventos=${ws.jobs.length}`);
  const final = await waitFinal(ws.jobs, jobId);
  check('llegó evento terminal por WS', !!final, `eventos=${JSON.stringify(ws.jobs.map((j) => j.status))}`);
  check('terminó en done (no error)', final?.status === 'done', final?.error || '');
  check('trae took_ms', Number(final?.took_ms) >= 0, `took_ms=${final?.took_ms}`);
  const wsResult = final?.result || {};
  check('el result del WS es el MatchResult', typeof wsResult.match_rate !== 'undefined' || typeof wsResult.matched !== 'undefined', JSON.stringify(wsResult).slice(0, 160));
  if (final?.status === 'done') console.log(`    → ${wsResult.matched} de ${wsResult.bank_movements} retiros · ${wsResult.match_rate}% en ${final.took_ms}ms`);

  // ── 3-4. registro consultable ──
  console.log('\n── 3. GET /finance/jobs ──');
  const one = await http('GET', `/finance/jobs/${jobId}`, null, token);
  check('GET /finance/jobs/:id 200', one.status === 200, `status=${one.status}`);
  check('estado done', one.body?.status === 'done', `status=${one.body?.status}`);
  check('conserva el result', !!one.body?.result, JSON.stringify(one.body?.result || null).slice(0, 120));
  check('finished_at poblado', !!one.body?.finished_at);

  const list = await http('GET', '/finance/jobs?limit=10', null, token);
  check('GET /finance/jobs lista', Array.isArray(list.body), `status=${list.status}`);
  check('el job aparece en el listado', (list.body || []).some((j) => j.job_id === jobId || j.id === jobId), `n=${list.body?.length}`);

  const missing = await http('GET', '/finance/jobs/00000000-0000-0000-0000-000000000000', null, token);
  check('job inexistente → 404', missing.status === 404, `status=${missing.status}`);

  // ── 5. escape hatch inline (lo que usan CLI y smokes) ──
  console.log('\n── 4. ?sync=true (inline) ──');
  const inline = await http('POST', `/finance/bank/match?sync=true`, { period }, token);
  check('sync=true responde 200/201', inline.status === 200 || inline.status === 201, `status=${inline.status}`);
  check('sync=true devuelve el resultado, no un job', !inline.body?.job_id && typeof inline.body?.match_rate !== 'undefined', JSON.stringify(inline.body)?.slice(0, 160));
  check('mismo resultado que por WS', inline.body?.bank_movements === wsResult.bank_movements, `inline=${inline.body?.bank_movements} ws=${wsResult.bank_movements}`);

  // ── 6. mismo contrato en el motor de Maat ──
  console.log('\n── 5. Motor de Maat (scan) ──');
  const scan = await http('POST', '/finance/maat/findings/scan', {}, token);
  check('scan responde 202', scan.status === 202, `status=${scan.status}`);
  check('scan trae job_id + name maat-scan', !!scan.body?.job_id && scan.body?.name === 'maat-scan', JSON.stringify(scan.body)?.slice(0, 160));
  if (scan.body?.job_id) {
    const scanFinal = await waitFinal(ws.jobs, scan.body.job_id, 120_000);
    check('scan terminó y avisó por WS', !!scanFinal, 'sin evento terminal en 120s');
    if (scanFinal?.status === 'done') console.log(`    → ${scanFinal.result?.nuevos} nuevos en ${scanFinal.result?.reglas} reglas (${scanFinal.took_ms}ms)`);
    else if (scanFinal) check('scan sin error', false, scanFinal.error || '');
  }

  // ── 6. el canal de Finanzas no es para todo el tenant ──
  console.log('-- 6. Gate del canal WS --');
  const portal = await http('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'cliente_demo', password: 'cliente_demo' });
  if (portal.body?.access_token) {
    const reason = await expectReject(portal.body.access_token);
    check('usuario sin permisos de Finanzas es rechazado del WS', reason === 'forbidden', `motivo=${reason}`);
  } else {
    console.log(`    (no pude loguear cliente_demo: status=${portal.status} — se omite el gate)`);
  }

  ws.socket.disconnect();
  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pass} OK · ${fail} FAIL\n${'='.repeat(60)}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR fatal:', e.message); process.exit(1); });
