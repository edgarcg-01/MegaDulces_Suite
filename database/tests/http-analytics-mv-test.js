/* eslint-disable no-console */
/**
 * HTTP smoke test del Sprint C.1 — MVs analytics.*
 * Verifica:
 *   1. overview/top-customers/top-products default → source='mv'
 *   2. mismo endpoint con ?live=true → source='live' y mismos datos numéricos
 *   3. POST /commercial/analytics/refresh actualiza refreshed_at
 *   4. Tenant 2 nuevo NO ve datos de tenant 1 en MVs (tenant filter explícito)
 */
const BASE = 'http://localhost:3334/api';

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, body: json };
}

let pass = 0,
  fail = 0;
function check(name, cond, det) {
  if (cond) {
    console.log(`  OK  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`);
    fail++;
  }
}

(async () => {
  // Login tenant 1
  const login = await req('POST', '/auth-mt/login', null, {
    tenant_slug: 'mega_dulces',
    username: 'superoot',
    password: 'superoot',
  });
  const token = login.body.access_token;
  check('login OK', !!token);

  // PRE-REFRESH: garantizar que las MVs reflejen el estado actual antes de
  // comparar con live (sin esto, tests previos pueden haber creado orders que
  // todavía no están en las MVs).
  await req('POST', '/commercial/analytics/refresh', token);

  console.log('\n── 1. Overview MV vs live ──');
  const ovMv = await req('GET', '/commercial/analytics/overview', token);
  check('overview default source=mv', ovMv.body?.source === 'mv', `source=${ovMv.body?.source}`);
  check('overview MV tiene refreshed_at', !!ovMv.body?.refreshed_at);
  console.log(
    `    MV: revenue=${ovMv.body?.revenue?.gross} fulfilled=${ovMv.body?.orders?.fulfilled} refreshed_at=${ovMv.body?.refreshed_at}`,
  );

  const ovLive = await req('GET', '/commercial/analytics/overview?live=true', token);
  check('overview ?live=true source=live', ovLive.body?.source === 'live');
  console.log(`    live: revenue=${ovLive.body?.revenue?.gross} fulfilled=${ovLive.body?.orders?.fulfilled}`);

  // Datos numéricos deben coincidir (mismas reglas, mismo período de 30d implícito)
  // Nota: MV no usa date range explícito (siempre 30d rolling). Live sin date range
  // toma TODO. Pueden diferir si hay data >30d. En testdata todos son hoy.
  check(
    'MV y live coinciden en revenue.gross (testdata reciente)',
    ovMv.body?.revenue?.gross === ovLive.body?.revenue?.gross,
    `mv=${ovMv.body?.revenue?.gross} live=${ovLive.body?.revenue?.gross}`,
  );

  console.log('\n── 2. Top customers MV vs live ──');
  const tcMv = await req('GET', '/commercial/analytics/top-customers?limit=5', token);
  const tcLive = await req('GET', '/commercial/analytics/top-customers?limit=5&live=true', token);
  check('top-customers default source=mv', tcMv.body?.[0]?.source === 'mv');
  check('top-customers ?live=true source=live', tcLive.body?.[0]?.source === 'live');
  check(
    'top-customers MV y live primer entry coincide (customer_id)',
    tcMv.body?.[0]?.customer_id === tcLive.body?.[0]?.customer_id,
  );
  check(
    'top-customers MV y live revenue coincide',
    Number(tcMv.body?.[0]?.revenue) === Number(tcLive.body?.[0]?.revenue),
  );
  console.log(`    #1 MV: ${tcMv.body?.[0]?.name} rev=${tcMv.body?.[0]?.revenue} rank=${tcMv.body?.[0]?.rank}`);

  console.log('\n── 3. Top products MV vs live ──');
  const tpMv = await req('GET', '/commercial/analytics/top-products?limit=5&orderBy=revenue', token);
  const tpLive = await req(
    'GET',
    '/commercial/analytics/top-products?limit=5&orderBy=revenue&live=true',
    token,
  );
  check('top-products default source=mv', tpMv.body?.[0]?.source === 'mv');
  check('top-products MV tiene rank_by_revenue', typeof tpMv.body?.[0]?.rank_by_revenue === 'number');
  check(
    'top-products MV y live primer entry coincide',
    tpMv.body?.[0]?.product_id === tpLive.body?.[0]?.product_id,
  );
  console.log(`    #1 MV: ${tpMv.body?.[0]?.product_name} revenue=${tpMv.body?.[0]?.revenue}`);

  console.log('\n── 4. Refresh manual ──');
  const refreshedAtBefore = ovMv.body?.refreshed_at;
  await new Promise((r) => setTimeout(r, 1100)); // esperar 1s para que el timestamp cambie
  const refreshResp = await req('POST', '/commercial/analytics/refresh', token);
  check('POST /refresh status 200/201', refreshResp.status >= 200 && refreshResp.status < 300, `status=${refreshResp.status}`);
  check('refresh devuelve refreshed_at', !!refreshResp.body?.refreshed_at);
  check('refresh devuelve 3 results', Array.isArray(refreshResp.body?.results) && refreshResp.body.results.length === 3);
  check(
    'refresh todos los results ok',
    Array.isArray(refreshResp.body?.results) && refreshResp.body.results.every((r) => r.ok),
  );
  refreshResp.body?.results?.forEach((r) =>
    console.log(`    ${r.mv}: ok=${r.ok} ${r.ms}ms`),
  );

  // Verificar que refreshed_at cambió en la MV
  const ovAfter = await req('GET', '/commercial/analytics/overview', token);
  check(
    'refreshed_at avanzó tras refresh',
    new Date(ovAfter.body?.refreshed_at).getTime() > new Date(refreshedAtBefore).getTime(),
    `before=${refreshedAtBefore} after=${ovAfter.body?.refreshed_at}`,
  );

  console.log('\n── 5. Tenant isolation en MVs ──');
  // Setup mini-tenant 2 (vía conexión directa porque tenants-admin no tiene auth todavía)
  const bcrypt = require('bcryptjs');
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
  const T2 = '00000000-0000-0000-0000-000000003333';
  await knex('public.tenants')
    .insert({ id: T2, slug: 'iso_mv_test', nombre: 'Iso MV Test', plan: 'standard', activo: true })
    .onConflict('id').merge(['activo']);
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${T2}'`);
    await trx('public.role_permissions')
      .insert({ tenant_id: T2, role_name: 'superadmin', permissions: '{}' })
      .onConflict(['tenant_id', 'role_name']).merge();
    const hash = await bcrypt.hash('isotest', 10);
    await trx('public.users')
      .insert({
        id: '00000000-0000-0000-0000-000000003a01',
        tenant_id: T2,
        username: 'isomvuser',
        password_hash: hash,
        nombre: 'Iso MV',
        role_name: 'superadmin',
        activo: true,
      })
      .onConflict('id').merge(['password_hash', 'activo']);
  });

  const t2Login = await req('POST', '/auth-mt/login', null, {
    tenant_slug: 'iso_mv_test',
    username: 'isomvuser',
    password: 'isotest',
  });
  const t2Token = t2Login.body?.access_token;
  check('tenant 2 login OK', !!t2Token);

  const t2Ov = await req('GET', '/commercial/analytics/overview', t2Token);
  check(
    'tenant 2 ve overview con revenue=0 (no debe ver data de mega_dulces)',
    Number(t2Ov.body?.revenue?.gross || 0) === 0,
    `t2 revenue=${t2Ov.body?.revenue?.gross}`,
  );

  const t2Tc = await req('GET', '/commercial/analytics/top-customers', t2Token);
  check(
    'tenant 2 ve top-customers vacío',
    Array.isArray(t2Tc.body) && t2Tc.body.length === 0,
    `count=${t2Tc.body?.length}`,
  );

  const t2Tp = await req('GET', '/commercial/analytics/top-products', t2Token);
  check(
    'tenant 2 ve top-products vacío',
    Array.isArray(t2Tp.body) && t2Tp.body.length === 0,
    `count=${t2Tp.body?.length}`,
  );

  // Cleanup
  await knex('public.users').where({ id: '00000000-0000-0000-0000-000000003a01' }).delete();
  await knex('public.role_permissions').where({ tenant_id: T2 }).delete();
  await knex('public.tenants').where({ id: T2 }).delete();
  await knex.destroy();

  console.log('\n══════════════════════════════');
  console.log(`Resultado: OK ${pass}, FAIL ${fail}`);
  console.log('══════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
