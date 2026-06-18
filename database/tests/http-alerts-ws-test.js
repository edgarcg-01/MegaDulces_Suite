/* eslint-disable no-console */
/**
 * Sprint C.4 E2E test: WS alerts flow.
 *
 * 1. Login mega_dulces + login tenant 2.
 * 2. Connect WS de cada tenant a /alerts namespace.
 * 3. Trigger POST /commercial/alerts/test desde tenant 1 → tenant 1 recibe,
 *    tenant 2 NO recibe.
 * 4. Crear pedido confirmed con total > $3k → recibimos large_order + order_confirmed.
 * 5. Fulfill ese pedido → recibimos order_fulfilled.
 * 6. POST /commercial/alerts/scan-now → scanner emite low_stock_critical
 *    (productos cargados con stock bajo si hay).
 * 7. Sin JWT → rechaza con auth_error + disconnect.
 */

const { io } = require('socket.io-client');
const BASE = 'http://localhost:3334/api';
const WS_BASE = 'http://localhost:3334';

async function http(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
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

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const socket = io(`${WS_BASE}/alerts`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    const alerts = [];
    socket.on('alert', (a) => alerts.push(a));
    socket.on('connect', () => resolve({ socket, alerts }));
    socket.on('connect_error', (e) => reject(e));
    socket.on('auth_error', (e) => reject(new Error('auth_error: ' + JSON.stringify(e))));
    setTimeout(() => reject(new Error('connection timeout')), 5000);
  });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  // Setup tenant 2 via Knex directo
  require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
  const bcrypt = require('bcryptjs');
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
  const T2 = '00000000-0000-0000-0000-000000004444';
  const T2_USER = '00000000-0000-0000-0000-000000004a01';

  await knex('public.tenants')
    .insert({ id: T2, slug: 'ws_iso_test', nombre: 'WS Iso', plan: 'standard', activo: true })
    .onConflict('id').merge(['activo']);
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${T2}'`);
    await trx('public.role_permissions')
      .insert({ tenant_id: T2, role_name: 'superadmin', permissions: '{}' })
      .onConflict(['tenant_id', 'role_name']).merge();
    const hash = await bcrypt.hash('wsiso', 10);
    await trx('public.users')
      .insert({
        id: T2_USER,
        tenant_id: T2,
        username: 'wsisouser',
        password_hash: hash,
        nombre: 'WS Iso User',
        role_name: 'superadmin',
        activo: true,
      })
      .onConflict('id').merge(['password_hash', 'activo']);
  });

  // Login ambos tenants
  console.log('── 1. Logins ──');
  const t1Login = await http('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'superoot',
    password: 'superoot',
  });
  const t2Login = await http('POST', '/auth-mt/login', {
    tenant_slug: 'ws_iso_test',
    username: 'wsisouser',
    password: 'wsiso',
  });
  check('tenant 1 login OK', !!t1Login.body?.access_token);
  check('tenant 2 login OK', !!t2Login.body?.access_token);
  const t1Token = t1Login.body.access_token;
  const t2Token = t2Login.body.access_token;

  // Connect WS
  console.log('\n── 2. WS connect ──');
  const t1 = await connectWs(t1Token);
  const t2 = await connectWs(t2Token);
  check('tenant 1 WS connect OK', !!t1.socket);
  check('tenant 2 WS connect OK', !!t2.socket);

  // Auth fail con token bad. Nota: socket.io firea 'connect' antes de
  // ejecutar handleConnection en el server, así que el cliente recibe connect
  // momentáneamente y LUEGO el server lo desconecta. Verificamos que termine
  // disconnected (no que falle el connect).
  console.log('\n── 3. WS con token inválido ──');
  const badSocket = io(`${WS_BASE}/alerts`, {
    path: '/reports/socket.io',
    auth: { token: 'xxx_bad_token' },
    transports: ['websocket'],
    reconnection: false,
  });
  let gotAuthError = false;
  badSocket.on('auth_error', () => (gotAuthError = true));
  await wait(800); // dar tiempo al server a procesar handshake
  check(
    'token inválido → server disconnect',
    !badSocket.connected,
    `connected=${badSocket.connected}`,
  );
  check('token inválido → emite auth_error event', gotAuthError);
  badSocket.disconnect();

  await wait(200); // dejar que cualquier evento previo se procese

  // Test alert manual desde tenant 1
  console.log('\n── 4. Manual test alert ──');
  t1.alerts.length = 0;
  t2.alerts.length = 0;
  const trigger = await http(
    'POST',
    '/commercial/alerts/test',
    { message: 'smoke test C.4' },
    t1Token,
  );
  check('POST /alerts/test status 2xx', trigger.status >= 200 && trigger.status < 300);
  await wait(500);
  check('tenant 1 RECIBIÓ alert', t1.alerts.length === 1, `got ${t1.alerts.length}`);
  check(
    'tenant 2 NO recibió alert (aislamiento)',
    t2.alerts.length === 0,
    `got ${t2.alerts.length}`,
  );
  if (t1.alerts.length) {
    const a = t1.alerts[0];
    check('alert.type=test', a.type === 'test');
    check('alert tiene emitted_at', !!a.emitted_at);
    console.log(`    payload: ${a.title} — ${a.message}`);
  }

  // Order flow → alerts large_order + order_confirmed + order_fulfilled
  console.log('\n── 5. Order flow → alerts ──');
  t1.alerts.length = 0;
  // Pick customer + warehouse + product+price
  const customers = await http('GET', '/commercial/customers?search=TST-0001&pageSize=10', null, t1Token);
  const customer = customers.body.data.find((c) => c.code === 'TST-0001');
  const wh = (await http('GET', '/commercial/warehouses', null, t1Token)).body.find(
    (w) => w.code === 'MD-CENTRAL',
  );
  const pls = (await http('GET', '/commercial/price-lists', null, t1Token)).body;
  const basePl = pls.find((p) => p.code === 'BASE-MXN');
  const pricesResp = await http('GET', `/commercial/price-lists/${basePl.id}/prices?pageSize=1000`, null, t1Token);
  const prices = Array.isArray(pricesResp.body) ? pricesResp.body : (pricesResp.body?.data || []);
  // Buscar producto caro para superar $3k. /prices es catálogo LEFT-JOIN precios →
  // filtrar a los que tienen precio real antes de ordenar (si no, sort con null elige ~0).
  const expensive = [...prices].filter((p) => p.price != null && Number(p.price) > 0).sort((a, b) => Number(b.price) - Number(a.price))[0];

  // Idempotencia: replenish stock para el producto elegido a un nivel seguro
  // antes de tomar la orden. Sin esto re-runs depletan el stock.
  await http(
    'POST',
    '/commercial/inventory/adjust',
    { warehouse_id: wh.id, product_id: expensive.product_id, new_quantity: 500 },
    t1Token,
  );

  const draft = await http(
    'POST',
    '/commercial/orders',
    { customer_id: customer.id, warehouse_id: wh.id },
    t1Token,
  );
  await http(
    'POST',
    `/commercial/orders/${draft.body.id}/lines`,
    { product_id: expensive.product_id, quantity: 400 },
    t1Token,
  );
  const confirm = await http('POST', `/commercial/orders/${draft.body.id}/confirm`, null, t1Token);
  check(
    'order confirm exitoso (status=pending_approval)',
    confirm.body?.status === 'pending_approval',
    `status=${confirm.body?.status}`,
  );
  await wait(500);

  // emitLargeOrder se dispara en confirm() (cliente confirma)
  check(
    'recibimos large_order alert (total > $3k)',
    t1.alerts.some((a) => a.type === 'large_order'),
    `total=${confirm.body?.total}`,
  );

  t1.alerts.length = 0;
  const approve = await http('POST', `/commercial/orders/${draft.body.id}/approve`, null, t1Token);
  check('order approve exitoso (status=confirmed)', approve.body?.status === 'confirmed', `status=${approve.body?.status}`);
  await wait(500);
  // emitOrderConfirmed se dispara en approve() (vendedor aprueba)
  check(
    'recibimos order_confirmed alert tras approve',
    t1.alerts.some((a) => a.type === 'order_confirmed'),
  );

  t1.alerts.length = 0;
  const ff = await http('POST', `/commercial/orders/${draft.body.id}/fulfill`, null, t1Token);
  check('order fulfill exitoso', ff.body?.status === 'fulfilled');
  await wait(500);
  check(
    'recibimos order_fulfilled alert',
    t1.alerts.some((a) => a.type === 'order_fulfilled'),
  );

  // Scanner manual → low_stock_critical (si hay productos < 50)
  console.log('\n── 6. Scanner manual ──');
  t1.alerts.length = 0;
  const scan = await http('POST', '/commercial/alerts/scan-now', null, t1Token);
  check('POST /alerts/scan-now status 2xx', scan.status >= 200 && scan.status < 300);
  console.log(`    Scan: tenants=${scan.body?.tenants} alerts_emitted=${scan.body?.alerts_emitted}`);
  await wait(500);
  // No asserteamos que low_stock haya emitido — depende de si quedaron productos bajo umbral
  // tras los pedidos previos. Solo verificamos que el endpoint funciona.

  // P2.2b — expiring_lots: almacén dedicado + lote a +3d → scan emite alerta de caducidad.
  // Almacén dedicado para no contaminar MD-CENTRAL; al soft-deletearlo queda inactive
  // (w.active=false) y deja de escanearse en runs futuros. Solo lotes con expiry real
  // disparan esta alerta (el backfill usó expiry NULL), así que no hay flood.
  console.log('\n── 6b. P2.2b · alerta de lote por vencer ──');
  const expTs = Date.now().toString().slice(-8);
  const expWhResp = await http('POST', '/commercial/warehouses', { code: `EXPALERT-${expTs}`, name: `Exp Alert ${expTs}`, is_default: false }, t1Token);
  const expWhId = expWhResp.body?.id;
  const expWhCode = `EXPALERT-${expTs}`;
  const expDate = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await http('POST', '/commercial/inventory/movements', {
    warehouse_id: expWhId, product_id: expensive.product_id, movement_type: 'in', quantity: 7, lot_code: `CRIT-${expTs}`, expiry_date: expDate,
  }, t1Token);
  t1.alerts.length = 0;
  const scan2 = await http('POST', '/commercial/alerts/scan-now', null, t1Token);
  check('scan-now (expiring) status 2xx', scan2.status >= 200 && scan2.status < 300);
  await wait(700);
  const expAlert = t1.alerts.find((a) => a.type === 'expiring_lots' && a.data?.warehouse_code === expWhCode);
  check('recibimos expiring_lots alert para el lote a +3d', !!expAlert, { expiring_alerts: t1.alerts.filter((a) => a.type === 'expiring_lots').length });
  check('expiring_lots severidad critical (<= 7d)', expAlert?.severity === 'critical', { sev: expAlert?.severity });
  if (expWhId) await http('DELETE', `/commercial/warehouses/${expWhId}`, null, t1Token);

  // Stats
  console.log('\n── 7. Stats ──');
  const stats = await http('GET', '/commercial/alerts/stats', null, t1Token);
  check('GET /alerts/stats devuelve total_sockets >= 2', (stats.body?.total_sockets || 0) >= 2);

  // Cleanup
  t1.socket.disconnect();
  t2.socket.disconnect();
  await knex('public.users').where({ id: T2_USER }).delete();
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
