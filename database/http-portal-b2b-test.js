/* eslint-disable no-console */
/**
 * Sprint D.1 E2E test: Portal B2B básico.
 *
 * Flujo:
 *   1. Login cliente_demo (rol customer_b2b) → JWT con tenant_id (sin customer_id en payload).
 *   2. GET /commercial/orders/my → solo pedidos del customer linkeado al user.
 *   3. Login superoot (admin) → ve TODOS los pedidos.
 *   4. cliente_demo crea pedido draft → confirm → fulfill.
 *   5. GET /commercial/orders/:id/history → 4 entries (creation + confirmed + fulfilled).
 *   6. cliente_demo NO puede ver pedidos de OTROS customers (filter by customer_id en my).
 */

const BASE = 'http://localhost:3334/api';

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
  console.log('── 1. Logins ──');
  const adminLogin = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'superoot',
    password: 'superoot',
  });
  const clientLogin = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'cliente_demo',
    password: 'cliente_demo',
  });
  check('superoot login OK', !!adminLogin.body?.access_token);
  check('cliente_demo login OK', !!clientLogin.body?.access_token);
  check(
    'cliente_demo role_name=customer_b2b',
    clientLogin.body?.user?.role_name === 'customer_b2b',
    `got ${clientLogin.body?.user?.role_name}`,
  );
  const adminToken = adminLogin.body.access_token;
  const clientToken = clientLogin.body.access_token;

  console.log('\n── 2. Customer scope: GET /orders/my ──');
  const myInicial = await req('GET', '/commercial/orders/my', null, clientToken);
  check(
    'cliente_demo GET /my responde 200',
    myInicial.status === 200,
    `status=${myInicial.status}`,
  );
  // Tolera state from previous test runs — guardamos count baseline
  const initialCount = myInicial.body?.total || 0;
  check(
    'cliente_demo my orders responde con total numérico',
    typeof myInicial.body?.total === 'number',
    `total=${myInicial.body?.total}`,
  );

  // Admin ve TODOS
  const adminAll = await req('GET', '/commercial/orders', null, adminToken);
  check(
    'admin ve > 0 pedidos (todos los customers)',
    (adminAll.body?.total || 0) > 0,
    `total=${adminAll.body?.total}`,
  );

  console.log('\n── 3. Cliente crea pedido propio ──');
  // Get warehouse + first product with price
  const wh = (await req('GET', '/commercial/warehouses', null, clientToken)).body.find(
    (w) => w.code === 'MD-CENTRAL',
  );
  // Cliente_demo necesita conocer su propio customer_id — endpoint GET /commercial/customers
  // RLS lo limita a ver SU propio customer.
  const customers = await req('GET', '/commercial/customers', null, clientToken);
  // Asumir TST-PORTAL-001 está en su lista
  const myCustomer = customers.body?.data?.find((c) => c.code === 'TST-PORTAL-001');
  check('cliente_demo ve su propio customer', !!myCustomer);

  if (!myCustomer || !wh) {
    console.log('Setup incompleto — abort');
    process.exit(1);
  }

  // Crear draft
  const draft = await req(
    'POST',
    '/commercial/orders',
    { customer_id: myCustomer.id, warehouse_id: wh.id, notes: 'D.1 portal test' },
    clientToken,
  );
  check(
    'POST /orders draft OK',
    draft.body?.status === 'draft' && draft.body?.code?.startsWith('PD-2026-'),
    `status=${draft.body?.status} code=${draft.body?.code}`,
  );
  const orderId = draft.body.id;

  // Add line con producto que tenga precio. Usamos la price_list del customer (no la base global)
  // porque customer_b2b solo puede listar prices de SU price list.
  const plsResp = (await req('GET', '/commercial/price-lists', null, clientToken)).body;
  const pls = Array.isArray(plsResp) ? plsResp : (plsResp?.data || []);
  const ownPl = pls.find((p) => p.id === myCustomer.default_price_list_id) || pls.find((p) => p.code === 'BASE-MXN') || pls[0];
  const pricesResp = (await req(
    'GET',
    `/commercial/price-lists/${ownPl.id}/prices?pageSize=200`,
    null,
    clientToken,
  )).body;
  const prices = Array.isArray(pricesResp) ? pricesResp : (pricesResp?.data || []);
  const firstPrice = prices[0];

  // Reponer stock para evitar depletion en re-runs
  await req(
    'POST',
    '/commercial/inventory/adjust',
    { warehouse_id: wh.id, product_id: firstPrice.product_id, new_quantity: 500 },
    adminToken, // admin tiene COMMERCIAL_INVENTORY_AJUSTAR
  );

  const addLine = await req(
    'POST',
    `/commercial/orders/${orderId}/lines`,
    { product_id: firstPrice.product_id, quantity: 2 },
    clientToken,
  );
  check('POST /orders/:id/lines OK', typeof addLine.body?.line_total !== 'undefined');

  // Confirm (cliente → pending_approval)
  const confirm = await req('POST', `/commercial/orders/${orderId}/confirm`, null, clientToken);
  check('POST /confirm desde cliente OK (pending_approval)', confirm.body?.status === 'pending_approval', `status=${confirm.body?.status}`);

  // Approve (vendedor → confirmed)
  const approve = await req('POST', `/commercial/orders/${orderId}/approve`, null, adminToken);
  check('POST /approve (admin) OK (confirmed)', approve.body?.status === 'confirmed', `status=${approve.body?.status}`);

  // Fulfill (admin → fulfilled)
  const fulfill = await req(
    'POST',
    `/commercial/orders/${orderId}/fulfill`,
    null,
    adminToken,
  );
  check('POST /fulfill (admin) OK', fulfill.body?.status === 'fulfilled');

  console.log('\n── 4. Cliente ve SU pedido nuevo ──');
  const myAfter = await req('GET', '/commercial/orders/my', null, clientToken);
  check(
    'cliente_demo my orders aumentó tras crear pedido',
    (myAfter.body?.total || 0) === initialCount + 1,
    `before=${initialCount} after=${myAfter.body?.total}`,
  );

  console.log('\n── 5. Order status history ──');
  const history = await req('GET', `/commercial/orders/${orderId}/history`, null, adminToken);
  check('GET /history responde array', Array.isArray(history.body));
  // State machine actual: null→draft, draft→pending_approval, pending_approval→confirmed, confirmed→fulfilled (4 entries)
  check(
    'history tiene 4 entries (null→draft→pending_approval→confirmed→fulfilled)',
    Array.isArray(history.body) && history.body.length === 4,
    `count=${history.body?.length}`,
  );
  if (Array.isArray(history.body)) {
    const transitions = history.body.map((h) => `${h.from_status || 'INIT'}→${h.to_status}`).join(' / ');
    console.log(`    Transiciones: ${transitions}`);
    check('1st: null→draft', history.body[0]?.from_status === null && history.body[0]?.to_status === 'draft');
    check('2nd: draft→pending_approval', history.body[1]?.from_status === 'draft' && history.body[1]?.to_status === 'pending_approval');
    check('3rd: pending_approval→confirmed', history.body[2]?.from_status === 'pending_approval' && history.body[2]?.to_status === 'confirmed');
    check('4th: confirmed→fulfilled', history.body[3]?.from_status === 'confirmed' && history.body[3]?.to_status === 'fulfilled');
    check(
      'history entries tienen changed_by_username',
      history.body.some((h) => !!h.changed_by_username),
    );
  }

  console.log('\n── 6. Customer NO ve pedidos de otros customers ──');
  // El service ahora fuerza customer_id=JWT.customer_id para rol customer_b2b
  // tanto en /orders como en /my (controller dice: "Si el rol es customer_b2b,
  // el filtro customer_id se fuerza al customer del JWT — no puede listar
  // pedidos ajenos"). Por eso /orders y /my devuelven el MISMO conteo para
  // cliente_demo, y AMBOS deben ser estrictamente menores que lo que ve admin.
  const clientListAll = await req('GET', '/commercial/orders', null, clientToken);
  const clientListMy = await req('GET', '/commercial/orders/my', null, clientToken);
  const adminListAll = await req('GET', '/commercial/orders', null, adminToken);
  check(
    'customer_b2b: /orders count == /my count (server-side scope)',
    clientListAll.body?.total === clientListMy.body?.total,
    `all=${clientListAll.body?.total} my=${clientListMy.body?.total}`,
  );
  check(
    'customer_b2b ve MENOS pedidos que admin (otros customers están filtrados)',
    (clientListMy.body?.total || 0) < (adminListAll.body?.total || 0),
    `clientMy=${clientListMy.body?.total} adminAll=${adminListAll.body?.total}`,
  );

  console.log('\n══════════════════════════════');
  console.log(`Resultado: OK ${pass}, FAIL ${fail}`);
  console.log('══════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
