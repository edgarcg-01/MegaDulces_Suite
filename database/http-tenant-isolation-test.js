/* eslint-disable no-console */
/**
 * HTTP tenant isolation test: crea un 2do tenant + 1er usuario, hace login,
 * y verifica que NO ve ninguna data de Mega Dulces. Después limpia.
 */

const BASE = 'http://localhost:3334/api';
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });

async function req(method, path, body, token) {
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
  } catch (e) {
    /* */
  }
  return { status: r.status, body: json };
}

let pass = 0;
let fail = 0;
function check(name, cond, det) {
  if (cond) {
    console.log(`  OK  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`);
    fail++;
  }
}

const TENANT2_ID = '00000000-0000-0000-0000-000000002222';
const USER2_ID = '00000000-0000-0000-0000-000000002a01';

(async () => {
  try {
    // Setup: crear tenant 2 + role superadmin + user en tenant 2
    console.log('── Setup tenant 2 ──');
    await knex('public.tenants')
      .insert({
        id: TENANT2_ID,
        slug: 'tenant_isolation_test',
        nombre: 'Tenant Isolation Test',
        plan: 'standard',
        activo: true,
      })
      .onConflict('id')
      .merge(['nombre', 'activo']);
    console.log('  tenant 2 creado/upserted');

    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${TENANT2_ID}'`);
      await trx('public.role_permissions')
        .insert({
          tenant_id: TENANT2_ID,
          role_name: 'superadmin',
          permissions: JSON.stringify({}),
        })
        .onConflict(['tenant_id', 'role_name'])
        .merge(['permissions']);
      console.log('  role superadmin creado para tenant 2');

      const hash = await bcrypt.hash('test2pass', 10);
      await trx('public.users')
        .insert({
          id: USER2_ID,
          tenant_id: TENANT2_ID,
          username: 'isouser',
          password_hash: hash,
          nombre: 'Iso User',
          role_name: 'superadmin',
          activo: true,
        })
        .onConflict('id')
        .merge(['password_hash', 'activo']);
      console.log('  usuario isouser creado para tenant 2');
    });

    // Login como tenant 2
    console.log('\n── Login tenant 2 ──');
    const login = await req('POST', '/auth-mt/login', {
      tenant_slug: 'tenant_isolation_test',
      username: 'isouser',
      password: 'test2pass',
    });
    check('login tenant 2 OK', !!login.body?.access_token);
    check(
      'tenant_id en JWT = tenant 2',
      login.body?.user?.tenant_id === TENANT2_ID,
      `got ${login.body?.user?.tenant_id}`,
    );
    const token2 = login.body?.access_token;

    // Login como tenant 1 (mega_dulces) para comparar
    const login1 = await req('POST', '/auth-mt/login', {
      tenant_slug: 'mega_dulces',
      username: 'superoot',
      password: 'superoot',
    });
    const token1 = login1.body?.access_token;

    console.log('\n── Verificación de aislamiento ──');

    // Tenant 1 ve customers
    const c1 = await req('GET', '/commercial/customers?pageSize=200', null, token1);
    check('Tenant 1 (mega_dulces) ve customers', (c1.body?.total || 0) > 0, `total=${c1.body?.total}`);

    // Tenant 2 NO ve customers
    const c2 = await req('GET', '/commercial/customers?pageSize=200', null, token2);
    check(
      'Tenant 2 (iso) NO ve customers',
      c2.body?.total === 0,
      `total=${c2.body?.total}`,
    );

    // Tenant 1 ve warehouses
    const w1 = await req('GET', '/commercial/warehouses', null, token1);
    check('Tenant 1 ve warehouses', Array.isArray(w1.body) && w1.body.length > 0);

    // Tenant 2 NO ve warehouses
    const w2 = await req('GET', '/commercial/warehouses', null, token2);
    check(
      'Tenant 2 NO ve warehouses',
      Array.isArray(w2.body) && w2.body.length === 0,
      `count=${w2.body?.length}`,
    );

    // Tenant 1 ve price-lists
    const pl1 = await req('GET', '/commercial/price-lists', null, token1);
    check('Tenant 1 ve price-lists', Array.isArray(pl1.body) && pl1.body.length > 0);

    // Tenant 2 NO ve price-lists
    const pl2 = await req('GET', '/commercial/price-lists', null, token2);
    check(
      'Tenant 2 NO ve price-lists',
      Array.isArray(pl2.body) && pl2.body.length === 0,
      `count=${pl2.body?.length}`,
    );

    // Tenant 1 ve stock
    const s1 = await req('GET', '/commercial/inventory/stock', null, token1);
    check('Tenant 1 ve stock', (s1.body?.total || 0) > 0);

    // Tenant 2 NO ve stock
    const s2 = await req('GET', '/commercial/inventory/stock', null, token2);
    check('Tenant 2 NO ve stock', s2.body?.total === 0, `total=${s2.body?.total}`);

    // Tenant 1 ve orders
    const o1 = await req('GET', '/commercial/orders', null, token1);
    check('Tenant 1 ve orders', (o1.body?.total || 0) > 0);

    // Tenant 2 NO ve orders
    const o2 = await req('GET', '/commercial/orders', null, token2);
    check('Tenant 2 NO ve orders', o2.body?.total === 0, `total=${o2.body?.total}`);

    // Try to access tenant 1's customer by UUID from tenant 2 → should 404
    const someCustomerId = c1.body?.data?.[0]?.id;
    if (someCustomerId) {
      const direct = await req('GET', `/commercial/customers/${someCustomerId}`, null, token2);
      check(
        'Tenant 2 NO puede acceder customer de tenant 1 por UUID directo',
        direct.status === 404,
        `status=${direct.status}`,
      );
    }

    // Cleanup
    console.log('\n── Cleanup ──');
    await knex('public.users').where({ id: USER2_ID }).delete();
    await knex('public.role_permissions')
      .where({ tenant_id: TENANT2_ID, role_name: 'superadmin' })
      .delete();
    await knex('public.tenants').where({ id: TENANT2_ID }).delete();
    console.log('  tenant 2 + dependencies eliminados');

    await knex.destroy();
    console.log('\n═════════════════════════════════');
    console.log(`Resultado isolation: OK ${pass}, FAIL ${fail}`);
    console.log('═════════════════════════════════');
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
    await knex.destroy();
    process.exit(1);
  }
})();
