/* eslint-disable no-console */
/**
 * HTTP E2E test: login + customers + warehouses + pricing + inventory + orders.
 * Requiere API corriendo en localhost:3334 con ENABLE_MULTITENANT=true.
 */

const BASE = 'http://localhost:3334/api';
let pass = 0;
let fail = 0;
const failures = [];

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
    /* no json body */
  }
  return { status: r.status, body: json };
}

function check(name, condition, detail) {
  if (condition) {
    console.log(`  OK  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
    fail++;
  }
}

(async () => {
  // 1. Login
  console.log('── 1. Login auth-mt ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'superoot',
    password: 'superoot',
  });
  check('login devuelve JWT', login.body?.access_token && login.body?.user?.tenant_id);
  const token = login.body?.access_token;
  if (!token) {
    console.log('No hay token — abort');
    process.exit(1);
  }

  // 2. Customers
  console.log('\n── 2. Customers ──');
  const list = await req('GET', '/commercial/customers?pageSize=5', null, token);
  check('GET list paginado', list.body?.data?.length > 0 && typeof list.body?.total === 'number');
  check('total >= 20 testdata', (list.body?.total || 0) >= 20, `total=${list.body?.total}`);

  // Code único por corrida — evita colisión por unique constraint en re-runs
  const uniqueCode = `HTTP-E2E-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const create = await req(
    'POST',
    '/commercial/customers',
    { code: uniqueCode, name: 'HTTP Test Customer' },
    token,
  );
  check('POST crea customer', create.status === 201 && create.body?.code === uniqueCode, `status=${create.status} body=${JSON.stringify(create.body).slice(0,80)}`);
  const newId = create.body?.id;

  const update = await req(
    'PATCH',
    `/commercial/customers/${newId}`,
    { credit_limit: 99999 },
    token,
  );
  check('PATCH actualiza customer', Number(update.body?.credit_limit) === 99999);

  const search = await req('GET', `/commercial/customers?search=${uniqueCode}`, null, token);
  check('search ?search=', (search.body?.data || []).some((c) => c.code === uniqueCode));

  // 3. Warehouses
  console.log('\n── 3. Warehouses ──');
  const wh = await req('GET', '/commercial/warehouses', null, token);
  const whArr = Array.isArray(wh.body) ? wh.body : [];
  check(
    'GET warehouses incluye MD-CENTRAL',
    whArr.some((w) => w.code === 'MD-CENTRAL'),
  );
  const mdCentralId = whArr.find((w) => w.code === 'MD-CENTRAL')?.id;

  // 4. Pricing
  console.log('\n── 4. Pricing ──');
  const pls = await req('GET', '/commercial/price-lists', null, token);
  const plsArr = Array.isArray(pls.body) ? pls.body : [];
  const basePl = plsArr.find((p) => p.code === 'BASE-MXN');
  check('GET price-lists incluye BASE-MXN', !!basePl);

  if (basePl) {
    const prices = await req('GET', `/commercial/price-lists/${basePl.id}/prices?pageSize=200`, null, token);
    const rows = Array.isArray(prices.body) ? prices.body : (prices.body?.data || []);
    check(
      'GET prices con >= 25 productos',
      rows.length >= 25,
      `count=${rows.length}`,
    );
  }

  // 5. Inventory
  console.log('\n── 5. Inventory ──');
  const stock = await req('GET', '/commercial/inventory/stock?pageSize=5', null, token);
  check(
    'GET stock con paginación y available_quantity',
    stock.body?.data?.length > 0 &&
      stock.body.data.every((r) => 'available_quantity' in r),
  );

  // 6. Orders flow
  console.log('\n── 6. Orders flow ──');
  // Pick TST-0002 customer. ?search= en vez de pageSize — el tenant tiene miles
  // de customers (bulk import) y TST-0002 queda fuera de cualquier página fija.
  const all = await req('GET', '/commercial/customers?search=TST-0002', null, token);
  const cust = (all.body?.data || []).find((c) => c.code === 'TST-0002');
  check('Customer TST-0002 disponible', !!cust);

  if (cust && mdCentralId) {
    const order = await req(
      'POST',
      '/commercial/orders',
      { customer_id: cust.id, warehouse_id: mdCentralId, notes: 'HTTP E2E' },
      token,
    );
    check('POST orders crea draft con code PD-2026-N', /^PD-2026-\d{5}$/.test(order.body?.code || ''), `code=${order.body?.code}`);

    const orderId = order.body?.id;

    // Pick a product with price
    const basePlFull = (pls.body || []).find((p) => p.code === 'BASE-MXN');
    const allPrices = await req('GET', `/commercial/price-lists/${basePlFull.id}/prices`, null, token);
    const firstPrice = (allPrices.body || [])[0];

    if (orderId && firstPrice) {
      const addLine = await req(
        'POST',
        `/commercial/orders/${orderId}/lines`,
        { product_id: firstPrice.product_id, quantity: 3 },
        token,
      );
      check('POST /orders/:id/lines calcula totals', typeof addLine.body?.line_total !== 'undefined');

      const confirm = await req('POST', `/commercial/orders/${orderId}/confirm`, null, token);
      check('POST /orders/:id/confirm → status=confirmed', confirm.body?.status === 'confirmed');

      const fulfill = await req('POST', `/commercial/orders/${orderId}/fulfill`, null, token);
      check('POST /orders/:id/fulfill → status=fulfilled', fulfill.body?.status === 'fulfilled');

      const detail = await req('GET', `/commercial/orders/${orderId}`, null, token);
      check('GET /orders/:id incluye lines', Array.isArray(detail.body?.lines) && detail.body.lines.length > 0);
    }
  }

  // 7. Sin auth
  console.log('\n── 7. Sin auth (sin Bearer) ──');
  const noAuth = await req('GET', '/commercial/customers', null, null);
  check(
    'Sin auth → no abre scope → 500 (TenantContext no seteado)',
    noAuth.status === 500 || noAuth.status === 401,
    `status=${noAuth.status}`,
  );

  // 8. Auth con tenant fake (JWT manipulado)
  console.log('\n── 8. JWT inválido ──');
  const badAuth = await req('GET', '/commercial/customers', null, 'BAD_TOKEN_xxx');
  check(
    'JWT inválido → tampoco abre scope → 500/401',
    badAuth.status === 500 || badAuth.status === 401,
    `status=${badAuth.status}`,
  );

  console.log('\n═════════════════════════════════');
  console.log(`Resultado: OK ${pass}, FAIL ${fail}`);
  if (failures.length) {
    console.log('Fallaron:');
    failures.forEach((f) => console.log('  -', f));
  }
  console.log('═════════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
