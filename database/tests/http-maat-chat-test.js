/* eslint-disable no-console */
/**
 * HTTP smoke test MAAT.0 + MAAT.3 — "Pregúntale a Maat" (ADR-028).
 * Verifica:
 *   1. GET  /finance/maat/knowledge → 27 entries activas + stats por kind
 *   2. POST /finance/maat/chat (pregunta real de egresos) → answer con source=llm,
 *      tools_used>0, session_id + message_id de audit
 *   3. Turno 2 en la MISMA sesión (session_id) → turns incrementa
 *   4. POST /finance/maat/chat/feedback → ok, feedback persistido en DB
 *   5. Audit en finance.chat_sessions/chat_messages (roles user+assistant, tool_calls)
 *
 * Requiere API corriendo (PORT en MAAT_TEST_PORT, default 3334) con
 * ANTHROPIC_API_KEY configurada. Sin key → el test marca skip del turno LLM.
 */
const BASE = `http://localhost:${process.env.MAAT_TEST_PORT || 3334}/api`;
const { Client } = require('pg');
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const M = '00000000-0000-0000-0000-00000000d01c';

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

let pass = 0, fail = 0;
function check(name, cond, det) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; }
}

(async () => {
  const login = await req('POST', '/auth-mt/login', null, {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const token = login.body?.access_token;
  check('login OK', !!token, `status=${login.status}`);
  if (!token) process.exit(1);

  console.log('\n── 1. Base de conocimiento (MAAT.0) ──');
  const kn = await req('GET', '/finance/maat/knowledge?limit=100', token);
  check('knowledge 200', kn.status === 200, `status=${kn.status}`);
  check('knowledge 27 entries activas', Array.isArray(kn.body) && kn.body.length === 27, `n=${kn.body?.length}`);
  const st = await req('GET', '/finance/maat/knowledge/stats', token);
  const kinds = Object.fromEntries((st.body?.by_kind || []).map((r) => [r.kind, r.num]));
  check('stats 4 kinds (7/7/6/7)', kinds.definicion === 7 && kinds.hecho === 7 && kinds.regla_negocio === 6 && kinds.issue_conocido === 7, JSON.stringify(kinds));

  console.log('\n── 2. Chat turno 1 (LLM + tools) ──');
  const t0 = Date.now();
  const c1 = await req('POST', '/finance/maat/chat', token, {
    history: [], message: '¿Cuánto gastamos en los últimos 90 días y cuáles son las 5 cuentas con más gasto?',
  });
  console.log(`    (${((Date.now() - t0) / 1000).toFixed(1)}s · iter=${c1.body?.iterations} · tools=${(c1.body?.tools_used || []).map((t) => t.name).join(',')})`);
  check('chat 201/200', c1.status === 200 || c1.status === 201, `status=${c1.status}`);
  if (c1.body?.source === 'no_api_key') {
    console.log('  SKIP resto del chat — sin ANTHROPIC_API_KEY');
  } else {
    check('source=llm', c1.body?.source === 'llm', `source=${c1.body?.source}`);
    check('answer no vacía', (c1.body?.answer || '').length > 40, `len=${c1.body?.answer?.length}`);
    check('usó ≥1 tool', (c1.body?.tools_used || []).length >= 1, `tools=${c1.body?.tools_used?.length}`);
    check('session_id + message_id de audit', !!c1.body?.session_id && !!c1.body?.message_id);
    console.log(`    → "${(c1.body?.answer || '').slice(0, 180).replace(/\n/g, ' ')}…"`);

    console.log('\n── 3. Chat turno 2 (misma sesión, proveedor) ──');
    const c2 = await req('POST', '/finance/maat/chat', token, {
      history: [
        { role: 'user', content: '¿Cuánto gastamos en los últimos 90 días?' },
        { role: 'assistant', content: c1.body.answer },
      ],
      message: '¿Y cuánto le debemos a DE LA ROSA?',
      session_id: c1.body.session_id,
    });
    check('turno 2 OK', (c2.status === 200 || c2.status === 201) && c2.body?.source === 'llm', `status=${c2.status} source=${c2.body?.source}`);
    check('misma sesión', c2.body?.session_id === c1.body.session_id, `${c2.body?.session_id} vs ${c1.body.session_id}`);
    check('usó maat_proveedor', (c2.body?.tools_used || []).some((t) => t.name === 'maat_proveedor'), (c2.body?.tools_used || []).map((t) => t.name).join(','));
    console.log(`    → "${(c2.body?.answer || '').slice(0, 180).replace(/\n/g, ' ')}…"`);

    console.log('\n── 4. Feedback 👍 ──');
    const fb = await req('POST', '/finance/maat/chat/feedback', token, { message_id: c1.body.message_id, vote: 1 });
    check('feedback ok', fb.body?.ok === true, JSON.stringify(fb.body));

    console.log('\n── 5. Audit en DB ──');
    const db = new Client({ connectionString: DST });
    await db.connect();
    try {
      const s = (await db.query(
        `SELECT turns, username FROM finance.chat_sessions WHERE tenant_id=$1 AND id=$2`, [M, c1.body.session_id])).rows[0];
      check('sesión existe con turns≥1', !!s && Number(s.turns) >= 1, JSON.stringify(s));
      const msgs = (await db.query(
        `SELECT role, feedback, tool_calls IS NOT NULL AS has_tools FROM finance.chat_messages
          WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at`, [M, c1.body.session_id])).rows;
      check('≥4 mensajes (2 turnos user+assistant)', msgs.length >= 4, `n=${msgs.length}`);
      check('assistant con tool_calls', msgs.some((m) => m.role === 'assistant' && m.has_tools));
      check('feedback up persistido', msgs.some((m) => m.feedback === 'up'), msgs.map((m) => m.feedback).join(','));
    } finally { await db.end(); }
  }

  console.log(`\n════ MAAT chat smoke: ${pass} OK · ${fail} FAIL ════`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
