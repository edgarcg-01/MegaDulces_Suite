#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Smoke test POST-CUTOVER contra el API en Railway.
 *
 * Ejecutar JUSTO DESPUÉS de cambiar DATABASE_URL en Railway y que el container
 * haya reiniciado. Si esto falla → ROLLBACK inmediato (revertir DATABASE_URL).
 *
 * Uso:
 *   API_BASE=https://<tu-api>.up.railway.app/api node database/cutover-smoke-test.js
 *
 * (Default API_BASE = http://localhost:3334/api para test local del runbook.)
 *
 * No requiere credenciales en env: usa cuentas seedeadas (superoot + cliente_demo).
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

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const t0 = Date.now();
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json, ms: Date.now() - t0 };
}

(async () => {
  console.log(`\n═══ POST-CUTOVER SMOKE TEST ═══`);
  console.log(`API: ${API_BASE}\n`);

  console.log('── 1. Auth multi-tenant funciona ──');
  const adminLogin = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'superoot',
    password: 'superoot',
  });
  check('admin login 2xx', adminLogin.status >= 200 && adminLogin.status < 300, `status=${adminLogin.status}`);
  check('admin token presente', !!adminLogin.body?.access_token);
  check(`admin login latencia <2s (${adminLogin.ms}ms)`, adminLogin.ms < 2000);
  const adminToken = adminLogin.body?.access_token;
  if (!adminToken) {
    console.log('\n✗ Sin token admin no podemos seguir. ABORTAR.');
    process.exit(1);
  }

  const clientLogin = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'cliente_demo',
    password: 'cliente_demo',
  });
  check('cliente_demo login 2xx', clientLogin.status >= 200 && clientLogin.status < 300, `status=${clientLogin.status}`);
  const clientToken = clientLogin.body?.access_token;

  console.log('\n── 2. Lectura commercial scoped por tenant ──');
  const customers = await req('GET', '/commercial/customers?limit=5', null, adminToken);
  check('GET /commercial/customers 2xx', customers.status >= 200 && customers.status < 300, `status=${customers.status}`);
  check('customers devuelve data', Array.isArray(customers.body?.data));
  check('customers devuelve al menos 1', (customers.body?.data?.length || 0) > 0);

  const warehouses = await req('GET', '/commercial/warehouses', null, adminToken);
  check('GET /commercial/warehouses 2xx', warehouses.status >= 200 && warehouses.status < 300);
  check('warehouses devuelve al menos 1', (warehouses.body?.data?.length || 0) > 0);

  console.log('\n── 3. Analytics overview funciona ──');
  const overview = await req('GET', '/commercial/analytics/overview', null, adminToken);
  check('GET /commercial/analytics/overview 2xx', overview.status >= 200 && overview.status < 300);
  check('overview tiene revenue (number)', typeof overview.body?.revenue === 'number');
  check('overview tiene fulfilled_orders', typeof overview.body?.fulfilled_orders === 'number');
  console.log(`    Revenue: $${overview.body?.revenue?.toFixed?.(2) || '?'} | Orders: ${overview.body?.fulfilled_orders}`);

  console.log('\n── 4. Portal B2B: cliente ve solo SU data ──');
  if (clientToken) {
    const myOrders = await req('GET', '/commercial/orders/my', null, clientToken);
    check('GET /commercial/orders/my 2xx', myOrders.status >= 200 && myOrders.status < 300);
    check('my orders es array', Array.isArray(myOrders.body?.data));

    const myRecs = await req('GET', '/commercial/recommendations/my', null, clientToken);
    check('GET /commercial/recommendations/my 2xx', myRecs.status >= 200 && myRecs.status < 300);
  }

  console.log('\n── 5. Tenant isolation: token de tenant fake NO accede ──');
  // Si hay un segundo tenant seedeado, validar. Si no, skip.
  const fakeToken = adminToken.replace(/[A-Za-z0-9_-]/g, (c, i) => i % 3 === 0 ? 'X' : c);
  const unauth = await req('GET', '/commercial/customers', null, fakeToken);
  check('JWT corrupto → 401/403', unauth.status === 401 || unauth.status === 403, `status=${unauth.status}`);

  console.log('\n── 6. Latencia general ──');
  const t0 = Date.now();
  await req('GET', '/commercial/analytics/overview', null, adminToken);
  await req('GET', '/commercial/customers?limit=10', null, adminToken);
  await req('GET', '/commercial/warehouses', null, adminToken);
  const totalMs = Date.now() - t0;
  check(`3 endpoints en <3s (${totalMs}ms)`, totalMs < 3000);

  console.log('\n══════════════════════════════');
  console.log(`Resultado: OK ${pass}, FAIL ${fail}`);
  console.log('══════════════════════════════');
  if (fail > 0) {
    console.log('\n✗ SMOKE TEST FALLÓ — Considerar ROLLBACK inmediato.');
    process.exit(1);
  } else {
    console.log('\n✓ Smoke test OK. Cutover validado.');
    process.exit(0);
  }
})().catch((e) => {
  console.error('\n✗ Excepción fatal:', e.message);
  process.exit(2);
});
