/* eslint-disable no-console */
/**
 * Test E2E J.10 — Visibilidad de tracking de embarques desde Comercial.
 *
 * Verifica el endpoint nuevo `GET /commercial/orders/:id/shipments`:
 *   1. Admin lo consume y devuelve array (vacío si no hay shipment).
 *   2. Al crear un shipment vinculado al order, aparece en el listado con
 *      campos básicos (folio, status, route_name, vehicle_plate).
 *   3. Tras depart → deliver → close, los timestamps `departure_at`,
 *      `arrival_at`, `closed_at` aparecen poblados.
 *   4. customer_b2b puede leer shipments de SU propio order (sin permiso
 *      LOGISTICS_SHIPMENTS_VER, reusando COMMERCIAL_ORDERS_VER).
 *   5. customer_b2b recibe 403 al intentar leer shipments de un order ajeno.
 *
 * Requisitos:
 *   - API en :3334 con ENABLE_MULTITENANT=true
 *   - cliente_demo + TST-PORTAL-001 + DEMO-001 (vehicle)
 *
 * Correr: node database/http-j10-order-tracking-test.js
 */

const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  console.log('── 1. Logins ──');
  const admin = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const adminToken = admin.body?.access_token;
  check('admin login OK', !!adminToken);

  const client = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'cliente_demo', password: 'cliente_demo',
  });
  const clientToken = client.body?.access_token;
  check('cliente_demo login OK', !!clientToken);
  if (!adminToken || !clientToken) process.exit(1);

  // 2. Setup: cliente_demo crea un order propio
  console.log('\n── 2. Cliente crea pedido + admin lo aprueba ──');
  const myCustomers = await req('GET', '/commercial/customers?pageSize=50', null, clientToken);
  const myCustomer = (myCustomers.body?.data || []).find((c) => c.code === 'TST-PORTAL-001');
  check('cliente_demo ve su customer', !!myCustomer?.id);
  if (!myCustomer?.id) process.exit(1);

  const whResp = await req('GET', '/commercial/warehouses', null, adminToken);
  const wh = (whResp.body || []).find((w) => w.is_default) || (whResp.body || [])[0];
  check('warehouse default disponible', !!wh?.id);

  const pricesResp = await req(
    'GET',
    `/commercial/price-lists/${myCustomer.default_price_list_id}/prices?pageSize=200`,
    null,
    clientToken,
  );
  const prices = pricesResp.body?.data || [];
  const stockResp = await req('GET', `/commercial/inventory/stock?warehouse_id=${wh.id}&pageSize=200`, null, adminToken);
  const stockList = stockResp.body?.data || [];
  const pricedIds = new Set(prices.map((p) => p.product_id));
  const stockEntry = stockList.find((s) => Number(s.quantity || 0) >= 5 && pricedIds.has(s.product_id));
  check('producto con precio + stock encontrado', !!stockEntry, { stockCount: stockList.length, pricedCount: pricedIds.size });
  if (!stockEntry) process.exit(1);

  // reponer stock por idempotencia
  await req('POST', '/commercial/inventory/adjust', {
    warehouse_id: wh.id, product_id: stockEntry.product_id, new_quantity: 500,
  }, adminToken);

  const draft = await req('POST', '/commercial/orders', {
    customer_id: myCustomer.id, warehouse_id: wh.id, notes: 'J.10 tracking test',
  }, clientToken);
  const orderId = draft.body?.id;
  check('order draft creado por cliente', !!orderId);
  if (!orderId) process.exit(1);

  await req('POST', `/commercial/orders/${orderId}/lines`, {
    product_id: stockEntry.product_id, quantity: 3,
  }, clientToken);
  const confirm = await req('POST', `/commercial/orders/${orderId}/confirm`, null, clientToken);
  check('order → pending_approval', confirm.body?.status === 'pending_approval', { status: confirm.body?.status });
  const approve = await req('POST', `/commercial/orders/${orderId}/approve`, null, adminToken);
  check('order → confirmed', approve.body?.status === 'confirmed', { status: approve.body?.status });

  // 3. ★ Endpoint nuevo: GET /orders/:id/shipments antes de crear shipment ──
  console.log('\n── 3. GET /orders/:id/shipments — vacío antes de crear shipment ──');
  const empty = await req('GET', `/commercial/orders/${orderId}/shipments`, null, clientToken);
  check('cliente_demo lee shipments de su order (status 200)', empty.status === 200, { status: empty.status, body: empty.body });
  check('shipments es array', Array.isArray(empty.body));
  check('shipments vacío antes de crear shipment', Array.isArray(empty.body) && empty.body.length === 0, { len: empty.body?.length });

  // 4. Crear shipment vinculado al order (admin)
  console.log('\n── 4. Admin crea shipment vinculado ──');
  const vehicles = await req('GET', '/logistics/fleet/vehicles', null, adminToken);
  const vehicle = (vehicles.body || []).find((v) => v.plate === 'DEMO-001') || (vehicles.body || []).find((v) => v.status === 'disponible');
  check('vehicle disponible encontrado', !!vehicle?.id);
  if (!vehicle?.id) process.exit(1);

  const today = new Date().toISOString().slice(0, 10);
  const ship = await req('POST', '/logistics/shipments', {
    shipment_date: today,
    vehicle_id: vehicle.id,
    order_id: orderId,
    origin: 'CEDIS',
    destination: 'J.10 test',
    type: 'entrega',
    boxes_count: 3,
  }, adminToken);
  const shipmentId = ship.body?.id;
  check('shipment creado con order_id', !!shipmentId && ship.body?.order_id === orderId);

  // 5. ★ Listado tras crear shipment ──
  console.log('\n── 5. Listado tras crear shipment ──');
  const listed = await req('GET', `/commercial/orders/${orderId}/shipments`, null, clientToken);
  check('cliente_demo ve el shipment recién creado', Array.isArray(listed.body) && listed.body.length === 1, { len: listed.body?.length });
  const s0 = (listed.body || [])[0] || {};
  check('shipment tiene folio EMB-*', /^EMB-\d{4}-\d+$/.test(s0.folio || ''), { folio: s0.folio });
  check('shipment status = programado', s0.status === 'programado', { status: s0.status });
  check('shipment vehicle_plate poblado', !!s0.vehicle_plate, { vehicle_plate: s0.vehicle_plate });
  check('departure_at todavía null', s0.departure_at === null);
  check('arrival_at todavía null', s0.arrival_at === null);

  // 6. State machine + verificación de timestamps
  console.log('\n── 6. depart → deliver → close + verificar timestamps ──');
  const depart = await req('POST', `/logistics/shipments/${shipmentId}/depart`, {}, adminToken);
  check('depart OK', depart.body?.status === 'en_ruta');

  const listedRouting = await req('GET', `/commercial/orders/${orderId}/shipments`, null, clientToken);
  const s1 = (listedRouting.body || [])[0] || {};
  check('cliente ve status=en_ruta tras depart', s1.status === 'en_ruta', { status: s1.status });
  check('departure_at poblado tras depart', !!s1.departure_at, { departure_at: s1.departure_at });

  await req('POST', `/logistics/shipments/${shipmentId}/deliver`, {}, adminToken);
  await req('POST', `/logistics/shipments/${shipmentId}/close`, {}, adminToken);

  const listedFinal = await req('GET', `/commercial/orders/${orderId}/shipments`, null, clientToken);
  const s2 = (listedFinal.body || [])[0] || {};
  check('cliente ve status=cerrado tras close', s2.status === 'cerrado', { status: s2.status });
  check('arrival_at poblado tras deliver', !!s2.arrival_at, { arrival_at: s2.arrival_at });
  check('closed_at poblado tras close', !!s2.closed_at, { closed_at: s2.closed_at });

  // 7. Hook: el order debió pasar a fulfilled
  const orderAfter = await req('GET', `/commercial/orders/${orderId}`, null, clientToken);
  check('order quedó en fulfilled tras close (hook intacto)', orderAfter.body?.status === 'fulfilled', { status: orderAfter.body?.status });

  // 8. ★ Aislamiento: customer_b2b NO puede leer shipments de un order ajeno
  console.log('\n── 8. Customer ajeno → 403 ──');
  // Buscar un order de OTRO customer (admin lista todos)
  const allOrders = await req('GET', '/commercial/orders?pageSize=10', null, adminToken);
  const otherOrder = (allOrders.body?.data || []).find((o) => o.customer_id !== myCustomer.id);
  if (otherOrder) {
    const forbidden = await req('GET', `/commercial/orders/${otherOrder.id}/shipments`, null, clientToken);
    check('cliente_demo recibe 403 en order ajeno', forbidden.status === 403, { status: forbidden.status });
  } else {
    console.log('  SKIP no hay order de otro customer para probar 403');
  }

  // 9. Admin puede leer shipments de cualquier order
  const adminView = await req('GET', `/commercial/orders/${orderId}/shipments`, null, adminToken);
  check('admin lee shipments del mismo order', Array.isArray(adminView.body) && adminView.body.length === 1);

  console.log(`\n────── Summary ──────`);
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  if (failures.length) console.log('Failures:', failures);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
