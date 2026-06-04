#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Validador POST-ROLLBACK: si se ejecutó rollback (DATABASE_URL revertido al
 * legacy), correr esto para confirmar que el API responde correctamente contra
 * la DB vieja.
 *
 * Uso:
 *   API_BASE=https://<tu-api>.up.railway.app/api node database/cutover-rollback-check.js
 *
 * Solo valida endpoints que existen en BOTH legacy y nueva (auth/health),
 * y NO los del módulo commercial (esos no existen en legacy).
 */

const API_BASE = process.env.API_BASE || 'http://localhost:3334/api';

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  OK   ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

(async () => {
  console.log(`\n═══ POST-ROLLBACK CHECK (back to legacy) ═══`);
  console.log(`API: ${API_BASE}\n`);

  // Login legacy: usa /auth/login (no /auth-mt/login porque legacy no es multi-tenant).
  const username = process.env.ROLLBACK_TEST_USER;
  const password = process.env.ROLLBACK_TEST_PASS;
  if (!username || !password) {
    console.log('Usar ROLLBACK_TEST_USER + ROLLBACK_TEST_PASS de un capturista de prueba.');
    process.exit(1);
  }

  const r = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  check('legacy /auth/login 2xx', r.status >= 200 && r.status < 300, `status=${r.status}`);
  check('legacy token presente', !!json?.access_token);

  if (json?.access_token) {
    const userResp = await fetch(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${json.access_token}` },
    });
    check('legacy /users/me 2xx', userResp.status >= 200 && userResp.status < 300, `status=${userResp.status}`);
  }

  console.log('\n══════════════════════════════');
  console.log(`Resultado: OK ${pass}, FAIL ${fail}`);
  console.log('══════════════════════════════');
  if (fail > 0) {
    console.log('\n✗ ROLLBACK FALLÓ. El API tampoco responde contra legacy — issue infraestructural.');
    process.exit(1);
  } else {
    console.log('\n✓ Rollback OK. API operativo contra legacy DB.');
    process.exit(0);
  }
})().catch((e) => {
  console.error('\n✗ Excepción fatal:', e.message);
  process.exit(2);
});
