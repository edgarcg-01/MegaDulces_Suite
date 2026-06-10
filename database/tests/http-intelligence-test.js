/* eslint-disable no-console */
/**
 * Fase M — Motor de Inteligencia Comercial. Smoke E2E del slice V1 (5 capas):
 *   Customer 360 (M.0) → NBA (M.1) → Agente (M.2) → señales/feedback (M.4).
 *
 * Requiere: API arriba con ENABLE_MULTITENANT=true y las 2 migraciones aplicadas
 * (commercial.customer_360 + commercial.commerce_signals). Aserciones tolerantes:
 * el `action`/`lifecycle_stage` dependen del historial real del cliente, así que
 * se verifica la FORMA del contrato, no valores fijos.
 *
 * Standalone. Agregar a run-all-tests.js SOLO tras aplicar migraciones y verlo verde.
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
const ok2xx = (s) => s >= 200 && s < 300;
const STAGES = ['new', 'active', 'at_risk', 'lost', 'reactivated'];

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
  const adminToken = admin.body?.access_token;
  const clientToken = client.body?.access_token;

  // Resolver el customer de prueba: el propio de cliente_demo (customer_b2b ve
  // solo el suyo). Es además el que /customer-360/my debe devolver. Robusto al
  // code/paginación: no hardcodea 'TST-PORTAL-001'.
  let customer = null;
  const mine = await req('GET', '/commercial/customers?pageSize=5', null, clientToken);
  const mineRows = mine.body?.data || mine.body || [];
  if (Array.isArray(mineRows) && mineRows.length) customer = mineRows[0];
  if (!customer) {
    // Fallback: lista admin (por code, o el primero disponible).
    const all = await req('GET', '/commercial/customers?pageSize=200', null, adminToken);
    const allRows = all.body?.data || all.body || [];
    const arr = Array.isArray(allRows) ? allRows : [];
    customer = arr.find((c) => c.code === 'TST-PORTAL-001') || arr[0] || null;
    console.log(`    (fallback admin: ${arr.length} customers en tenant)`);
  }
  check('hay customer de prueba (propio de cliente_demo)', !!customer, customer ? `code=${customer.code} id=${customer.id}` : 'ninguno');
  if (!customer) {
    console.log('\nAbortado: cliente_demo no tiene customer linkeado.');
    process.exit(1);
  }
  console.log(`    customer de prueba: ${customer.code} — ${customer.name}`);

  console.log('\n── 2. Customer 360 — refresh-all (cron manual) ──');
  const refresh = await req('POST', '/commercial/intelligence/customer-360/refresh', null, adminToken);
  check('POST /customer-360/refresh 2xx', ok2xx(refresh.status), `status=${refresh.status}`);
  check('refresh devuelve customers_refreshed', typeof refresh.body?.customers_refreshed === 'number');
  console.log(`    tenants=${refresh.body?.tenants} customers=${refresh.body?.customers_refreshed} errors=${refresh.body?.errors} ${refresh.body?.elapsed_ms}ms`);

  console.log('\n── 3. Customer 360 — compute + shape ──');
  const compute = await req('POST', `/commercial/intelligence/customer-360/${customer.id}/compute`, null, adminToken);
  check('POST /:id/compute 2xx', ok2xx(compute.status), `status=${compute.status}`);
  check('orders_count numérico', typeof compute.body?.orders_count === 'number');
  check('lifecycle_stage válido', STAGES.includes(compute.body?.lifecycle_stage), `stage=${compute.body?.lifecycle_stage}`);
  check('cadence_days null|número', compute.body?.cadence_days === null || typeof compute.body?.cadence_days === 'number');
  check('next_order_estimate null|string', compute.body?.next_order_estimate === null || typeof compute.body?.next_order_estimate === 'string');
  check('computed_at presente', !!compute.body?.computed_at);
  console.log(`    orders=${compute.body?.orders_count} stage=${compute.body?.lifecycle_stage} cadencia=${compute.body?.cadence_days} next=${compute.body?.next_order_estimate} recency=${compute.body?.recency_days}`);

  console.log('\n── 4. Customer 360 — /my (cliente) + /:id (admin) ──');
  const my = await req('GET', '/commercial/intelligence/customer-360/my', null, clientToken);
  check('GET /customer-360/my 2xx', ok2xx(my.status), `status=${my.status}`);
  check('/my mismo customer_id', my.body?.customer_id === customer.id, `my=${my.body?.customer_id}`);
  const adminGet = await req('GET', `/commercial/intelligence/customer-360/${customer.id}`, null, adminToken);
  check('admin GET /:id 2xx', ok2xx(adminGet.status), `status=${adminGet.status}`);

  console.log('\n── 5. NBA (Motor de Decisión) ──');
  const nbaList = await req('GET', '/commercial/intelligence/nba?limit=50', null, adminToken);
  check('GET /nba 2xx', ok2xx(nbaList.status), `status=${nbaList.status}`);
  check('/nba devuelve array', Array.isArray(nbaList.body));
  console.log(`    due-for-reorder en tenant: ${Array.isArray(nbaList.body) ? nbaList.body.length : '?'}`);
  const nba = await req('GET', `/commercial/intelligence/nba/${customer.id}`, null, adminToken);
  check('GET /nba/:id 2xx', ok2xx(nba.status), `status=${nba.status}`);
  check('nba.action válido', ['due_for_reorder', 'none'].includes(nba.body?.action), `action=${nba.body?.action}`);
  check('nba.reason texto', typeof nba.body?.reason === 'string' && nba.body.reason.length > 0);
  console.log(`    action=${nba.body?.action} urgency=${nba.body?.urgency} days_overdue=${nba.body?.days_overdue} — "${nba.body?.reason}"`);

  console.log('\n── 6. Canasta sugerida + Agente (mensaje) ──');
  const basket = await req('GET', `/commercial/intelligence/nba/${customer.id}/basket`, null, adminToken);
  check('GET /nba/:id/basket 2xx', ok2xx(basket.status), `status=${basket.status}`);
  check('basket.items array', Array.isArray(basket.body?.items));
  const msg = await req('GET', `/commercial/intelligence/nba/${customer.id}/message`, null, adminToken);
  check('GET /nba/:id/message 2xx', ok2xx(msg.status), `status=${msg.status}`);
  check('message.action válido', ['due_for_reorder', 'none'].includes(msg.body?.action));
  check('message.basket array', Array.isArray(msg.body?.basket));
  if (msg.body?.action === 'due_for_reorder') {
    check('due → message string', typeof msg.body?.message === 'string' && msg.body.message.length > 0);
    check('due → generated_by llm|template', ['llm', 'template'].includes(msg.body?.generated_by));
    console.log(`    [${msg.body?.generated_by}] "${msg.body?.message}"`);
  } else {
    check('none → message null', msg.body?.message === null);
    console.log(`    action=none (cliente no due) — sin mensaje, ok`);
  }

  console.log('\n── 7. Feedback loop (señales + conversión) ──');
  const sig = await req('POST', '/commercial/intelligence/signals', {
    customer_id: customer.id,
    signal_type: 'offer_shown',
    channel: 'vendor',
    context: { smoke: true },
  }, adminToken);
  check('POST /signals 2xx', ok2xx(sig.status), `status=${sig.status}`);
  check('signal devuelve id', !!sig.body?.id);
  const sigMy = await req('POST', '/commercial/intelligence/signals/my', {
    signal_type: 'offer_shown',
    channel: 'portal',
  }, clientToken);
  check('POST /signals/my (cliente) 2xx', ok2xx(sigMy.status), `status=${sigMy.status}`);
  check('signal/my devuelve id', !!sigMy.body?.id);
  const summary = await req('GET', '/commercial/intelligence/signals/summary?days=30', null, adminToken);
  check('GET /signals/summary 2xx', ok2xx(summary.status), `status=${summary.status}`);
  check('summary.offers >= 2 (recién posteadas)', typeof summary.body?.offers === 'number' && summary.body.offers >= 2, `offers=${summary.body?.offers}`);
  check('summary.conversion_pct numérico', typeof summary.body?.conversion_pct === 'number');
  console.log(`    offers=${summary.body?.offers} converted=${summary.body?.converted} conversion=${summary.body?.conversion_pct}%`);

  console.log('\n══════════════════════════════');
  console.log(`Resultado: OK ${pass}, FAIL ${fail}`);
  console.log('══════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e.message);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
