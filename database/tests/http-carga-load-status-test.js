/* eslint-disable no-console */
/**
 * Carga: checklist 'sí cargamos / no cargamos' (commercial.carga_load_items).
 *
 * Verifica el flujo del vendedor sobre una línea de un pedido existente:
 *   loaded → not_loaded (+motivo) → pending (borra) → bulk.
 * El estado es un registro auditable, desacoplado del status del pedido.
 *
 * Requiere: API :3334 con commercial-carga wireado + migración aplicada.
 */
const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0; const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = login.body?.access_token;
  check('login superoot', !!token);
  if (!token) { console.log('sin token — abort'); process.exit(1); }

  // Buscar un pedido con líneas (cualquier status: load-status está desacoplado).
  const list = await req('GET', '/commercial/orders?pageSize=20', null, token);
  const orders = list.body?.data || [];
  check('hay pedidos', orders.length > 0, orders.length);

  let orderId = null, line = null;
  for (const o of orders) {
    const detail = await req('GET', `/commercial/orders/${o.id}`, null, token);
    const lines = detail.body?.lines || [];
    if (lines.length > 0) { orderId = o.id; line = lines[0]; break; }
  }
  check('hay un pedido con al menos una línea', !!orderId && !!line, { orderId });
  if (!orderId) { console.log('sin pedido con líneas — abort'); process.exit(1); }
  const productId = line.product_id;

  console.log('\n── 1. Marcar línea: loaded ──');
  const put1 = await req('PUT', '/commercial/carga/load-status', {
    order_id: orderId, product_id: productId, status: 'loaded', quantity: Number(line.quantity) || 1,
    product_name: line.product_name || null, delivery_date: '2026-06-19',
  }, token);
  check('PUT loaded → 2xx', put1.status >= 200 && put1.status < 300, put1.status);
  let get1 = await req('GET', `/commercial/carga/load-status?order_ids=${orderId}`, null, token);
  let row = (get1.body || []).find((r) => r.product_id === productId);
  check('GET devuelve la línea como loaded', !!row && row.status === 'loaded', row);

  console.log('\n── 2. Cambiar a not_loaded + motivo ──');
  await req('PUT', '/commercial/carga/load-status', {
    order_id: orderId, product_id: productId, status: 'not_loaded', reason: 'sin_stock',
    quantity: Number(line.quantity) || 1,
  }, token);
  get1 = await req('GET', `/commercial/carga/load-status?order_ids=${orderId}`, null, token);
  row = (get1.body || []).find((r) => r.product_id === productId);
  check('línea ahora not_loaded', !!row && row.status === 'not_loaded', row?.status);
  check('motivo persistido (sin_stock)', !!row && row.reason === 'sin_stock', row?.reason);

  console.log('\n── 3. Volver a pending (borra la fila) ──');
  await req('PUT', '/commercial/carga/load-status', { order_id: orderId, product_id: productId, status: 'pending' }, token);
  get1 = await req('GET', `/commercial/carga/load-status?order_ids=${orderId}`, null, token);
  row = (get1.body || []).find((r) => r.product_id === productId);
  check('pending → la línea ya no tiene fila', !row, row);

  console.log('\n── 4. Bulk (varias líneas de una) ──');
  const bulk = await req('POST', '/commercial/carga/load-status/bulk', {
    items: [{ order_id: orderId, product_id: productId, status: 'loaded', quantity: 1 }],
  }, token);
  check('POST bulk → 2xx', bulk.status >= 200 && bulk.status < 300, bulk.status);
  get1 = await req('GET', `/commercial/carga/load-status?order_ids=${orderId}`, null, token);
  row = (get1.body || []).find((r) => r.product_id === productId);
  check('bulk dejó la línea loaded', !!row && row.status === 'loaded', row?.status);

  console.log('\n── 5. Validación: order_id inválido → 400 ──');
  const bad = await req('PUT', '/commercial/carga/load-status', { order_id: 'no-uuid', product_id: productId, status: 'loaded' }, token);
  check('order_id inválido → 400', bad.status === 400, bad.status);

  // cleanup: dejar la línea en pending (sin residuo)
  await req('PUT', '/commercial/carga/load-status', { order_id: orderId, product_id: productId, status: 'pending' }, token);

  console.log(`\n════════ Total: ${pass} pass / ${fail} fail ════════`);
  if (failures.length) console.log('Failures:\n  - ' + failures.join('\n  - '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
