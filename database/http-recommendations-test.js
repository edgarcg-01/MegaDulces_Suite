/* eslint-disable no-console */
/**
 * Sprint D.4 E2E test: canasta estratégica (recomendaciones).
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

let pass = 0, fail = 0;
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
  const admin = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'superoot',
    password: 'superoot',
  });
  const client = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'cliente_demo',
    password: 'cliente_demo',
  });
  check('admin login OK', !!admin.body?.access_token);
  check('cliente_demo login OK', !!client.body?.access_token);
  const adminToken = admin.body.access_token;
  const clientToken = client.body.access_token;

  // Get TST-PORTAL-001 via admin (customer_b2b /customers ahora solo devuelve el customer propio)
  const customers = await req('GET', '/commercial/customers?pageSize=50', null, adminToken);
  const rows = customers.body?.data || customers.body || [];
  const customer = (Array.isArray(rows) ? rows : []).find((c) => c.code === 'TST-PORTAL-001');
  check('cliente_demo ve TST-PORTAL-001', !!customer);

  console.log('\n── 2. Compute manual ──');
  const compute = await req(
    'POST',
    `/commercial/recommendations/${customer.id}/compute`,
    null,
    adminToken,
  );
  check('POST /compute status 2xx', compute.status >= 200 && compute.status < 300, `status=${compute.status}`);
  check('compute devuelve total_recommendations', typeof compute.body?.total_recommendations === 'number');
  check('compute devuelve category_counts', !!compute.body?.category_counts);
  check('compute devuelve items array', Array.isArray(compute.body?.items));
  console.log(
    `    Total items: ${compute.body?.total_recommendations}`,
    `→ base=${compute.body?.category_counts?.base}`,
    `focus=${compute.body?.category_counts?.focus}`,
    `exploration=${compute.body?.category_counts?.exploration}`,
    `innovation=${compute.body?.category_counts?.innovation}`,
  );

  console.log('\n── 3. /my desde cliente ──');
  const my = await req('GET', '/commercial/recommendations/my', null, clientToken);
  check('GET /my status 2xx', my.status >= 200 && my.status < 300);
  check('my devuelve items', Array.isArray(my.body?.items));
  check(
    'my y compute mismo customer_id',
    my.body?.customer_id === customer.id,
    `my=${my.body?.customer_id} compute=${customer.id}`,
  );

  console.log('\n── 4. Categorías presentes ──');
  if (Array.isArray(my.body?.items) && my.body.items.length > 0) {
    const categoriesSeen = new Set(my.body.items.map((i) => i.category));
    console.log(`    Categorías presentes: ${[...categoriesSeen].join(', ')}`);
    // Verificar estructura de items
    const first = my.body.items[0];
    check('item tiene product_id', !!first.product_id);
    check('item tiene product_name', !!first.product_name);
    check('item tiene category válida', ['base', 'focus', 'exploration', 'innovation'].includes(first.category));
    check('item tiene score 0..1', first.score >= 0 && first.score <= 1, `score=${first.score}`);
    check('item tiene reason texto', typeof first.reason === 'string' && first.reason.length > 0);
    check('item tiene sample_price numérico', typeof first.sample_price === 'number');
    console.log(`    Sample: [${first.category}] ${first.product_name} — score=${first.score} reason="${first.reason}" $${first.sample_price}`);
  }

  console.log('\n── 5. /:customer_id desde admin ──');
  const adminGet = await req('GET', `/commercial/recommendations/${customer.id}`, null, adminToken);
  check('admin GET /:customer_id status 2xx', adminGet.status >= 200 && adminGet.status < 300);
  check('admin ve mismas recomendaciones', adminGet.body?.total_recommendations === compute.body?.total_recommendations);

  console.log('\n── 6. Refresh-all (cron manual) ──');
  const refreshAll = await req('POST', '/commercial/recommendations/refresh-all', null, adminToken);
  check('POST /refresh-all status 2xx', refreshAll.status >= 200 && refreshAll.status < 300, `status=${refreshAll.status}`);
  check('refresh-all devuelve tenants count', typeof refreshAll.body?.tenants === 'number');
  check('refresh-all devuelve customers_refreshed', typeof refreshAll.body?.customers_refreshed === 'number');
  console.log(
    `    Refresh: tenants=${refreshAll.body?.tenants} customers=${refreshAll.body?.customers_refreshed} errors=${refreshAll.body?.errors} elapsed=${refreshAll.body?.elapsed_ms}ms`,
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
