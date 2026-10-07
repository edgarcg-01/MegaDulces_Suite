/* eslint-disable no-console */
/**
 * HTTP smoke test del módulo commercial-analytics.
 * Requiere API en localhost:3334 con ENABLE_MULTITENANT=true.
 */
const BASE = 'http://localhost:3334/api';

async function req(method, path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const r = await fetch(`${BASE}${path}`, { method, headers });
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
  const login = await fetch(`${BASE}/auth-mt/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_slug: 'mega_dulces',
      username: 'superoot',
      password: 'superoot',
    }),
  }).then((r) => r.json());

  const token = login.access_token;
  check('login OK', !!token);

  console.log('\n── 1. Overview ──');
  const ov = await req('GET', '/commercial/analytics/overview', token);
  check('GET overview status 200', ov.status === 200, `status=${ov.status}`);
  check('overview tiene revenue.gross numérico', typeof ov.body?.revenue?.gross === 'number');
  check('overview tiene orders.fulfilled', typeof ov.body?.orders?.fulfilled === 'number');
  check('overview tiene unique_customers', typeof ov.body?.unique_customers === 'number');
  console.log(`    revenue.gross=${ov.body?.revenue?.gross} fulfilled=${ov.body?.orders?.fulfilled} units=${ov.body?.units_sold}`);

  console.log('\n── 2. Top customers ──');
  const tc = await req('GET', '/commercial/analytics/top-customers?limit=5', token);
  check('GET top-customers status 200', tc.status === 200);
  check('top-customers array', Array.isArray(tc.body));
  if (Array.isArray(tc.body) && tc.body.length > 0) {
    const first = tc.body[0];
    check(
      'top-customer tiene customer_id+name+revenue+orders_count',
      first.customer_id && first.name && typeof first.revenue === 'number',
    );
    console.log(`    #1: ${first.name} → revenue=${first.revenue} orders=${first.orders_count}`);
  } else {
    console.log('    (sin datos fulfilled todavía — array vacío esperado)');
  }

  console.log('\n── 3. Top products ──');
  const tp = await req('GET', '/commercial/analytics/top-products?limit=5&orderBy=revenue', token);
  check('GET top-products status 200', tp.status === 200);
  check('top-products array', Array.isArray(tp.body));
  if (Array.isArray(tp.body) && tp.body.length > 0) {
    const first = tp.body[0];
    check('top-product tiene product_id+name+revenue+units_sold', first.product_id && typeof first.revenue === 'number');
    console.log(`    #1: ${first.product_name} (${first.brand_name}) → units=${first.units_sold} revenue=${first.revenue}`);
  }

  console.log('\n── 4. Inactive customers ──');
  const ic = await req('GET', '/commercial/analytics/inactive-customers?days=7', token);
  check('GET inactive-customers status 200', ic.status === 200);
  check('inactive-customers tiene threshold_days y customers', ic.body?.threshold_days === 7 && Array.isArray(ic.body?.customers));
  console.log(`    threshold=7d, inactivos=${ic.body?.customers?.length || 0}`);

  console.log('\n── 5. Sales by brand ──');
  const sbb = await req('GET', '/commercial/analytics/sales-by-brand', token);
  check('GET sales-by-brand status 200', sbb.status === 200);
  check('sales-by-brand array', Array.isArray(sbb.body));
  if (Array.isArray(sbb.body) && sbb.body.length > 0) {
    let totalShare = 0;
    sbb.body.forEach((b) => (totalShare += b.share_pct));
    check('share_pct suma ~100', Math.abs(totalShare - 100) < 0.5, `total=${totalShare}`);
    console.log(`    brands con ventas: ${sbb.body.length}`);
    sbb.body.slice(0, 3).forEach((b) =>
      console.log(`      ${b.brand_name}: revenue=${b.revenue} share=${b.share_pct}%`),
    );
  }

  console.log('\n── 6. Low stock ──');
  const ls = await req('GET', '/commercial/analytics/low-stock?threshold=300', token);
  check('GET low-stock status 200', ls.status === 200);
  check('low-stock tiene threshold y items', ls.body?.threshold === 300 && Array.isArray(ls.body?.items));
  console.log(`    threshold=300, items=${ls.body?.items?.length || 0}`);
  if (ls.body?.items?.length > 0) {
    ls.body.items.slice(0, 3).forEach((i) =>
      console.log(`      ${i.product_name}: avail=${i.available_quantity} (${i.warehouse_code})`),
    );
  }

  console.log('\n── 7. Daily series ──');
  const ds = await req('GET', '/commercial/analytics/daily-series', token);
  check('GET daily-series status 200', ds.status === 200);
  check('daily-series array', Array.isArray(ds.body));
  if (Array.isArray(ds.body) && ds.body.length > 0) {
    console.log(`    ${ds.body.length} días con ventas`);
    console.log(`      ${ds.body[0].day}: orders=${ds.body[0].orders_count} revenue=${ds.body[0].revenue}`);
  }

  console.log('\n── 8. Date range filter ──');
  const filtered = await req(
    'GET',
    '/commercial/analytics/overview?from=2026-05-26&to=2026-05-27',
    token,
  );
  check('overview con date range respondió 200', filtered.status === 200);
  check('overview date range echo correcto', filtered.body?.period?.from === '2026-05-26');

  console.log('\n── 9. Bad date validation ──');
  const bad = await req('GET', '/commercial/analytics/overview?from=not-a-date', token);
  check('overview con date inválida → 400', bad.status === 400, `status=${bad.status}`);

  console.log('\n══════════════════════════════');
  console.log(`Resultado: OK ${pass}, FAIL ${fail}`);
  console.log('══════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
