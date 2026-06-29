/* eslint-disable no-console */
/**
 * Test HTTP del endpoint POST /commercial/orders/:id/place — "tomar pedido en
 * campo" (preventa atómica) que reemplaza el encadenado confirm→approve del
 * vendedor, y que el replay offline reusa al reconectar.
 *
 * Cubre:
 *   1. Online: createDraft → addLine → place → confirmed (en 1 request).
 *   2. History: la transición quedó como draft→pending_approval→confirmed.
 *   3. Preventa NO reserva stock (se consume al repartir, igual que confirm).
 *   4. Idempotencia: un segundo place sobre el ya-confirmed es no-op (no 409,
 *      no duplica history) — protege el reintento del replay offline.
 *   5. Replay offline: createDraft → PUT /lines (replaceLines bulk) → place.
 *
 * Requisitos: API en :3334 con ENABLE_MULTITENANT=true, reiniciada con el código
 * del endpoint /place. Correr: node database/tests/http-vendor-place-test.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
const BASE = 'http://localhost:3334/api';
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}
function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

const created = [];

(async () => {
  let exitCode = 1;
  try {
    console.log('── 1. Login ──');
    const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
    const token = login.body?.access_token;
    check('JWT recibido', !!token, login.status);
    if (!token) { await knex.destroy(); process.exit(1); }

    // ── Setup directo: warehouse + customer + producto con precio + stock ──
    const wh = await knex('commercial.warehouses').where({ tenant_id: T, is_default: true }).first();
    const defaultList = await knex('commercial.price_lists').where({ tenant_id: T, is_default: true }).first();
    // Cualquier customer con price-list (el code DEMO-001 del seed ya no existe).
    let customer = await knex('commercial.customers').where({ tenant_id: T }).whereNotNull('default_price_list_id').first();
    if (!customer) customer = await knex('commercial.customers').where({ tenant_id: T }).first();
    const priceListId = customer?.default_price_list_id || defaultList?.id;
    check('warehouse default existe', !!wh);
    check('hay customer + price-list', !!customer && !!priceListId, { customer: customer?.code, priceListId });
    if (!wh || !customer || !priceListId) throw new Error('setup incompleto');

    const product = await knex('public.products').limit(1).first();
    const existingPrice = await knex('commercial.product_prices').where({ tenant_id: T, price_list_id: priceListId, product_id: product.id }).first();
    if (!existingPrice) {
      await knex('commercial.product_prices').insert({ tenant_id: T, price_list_id: priceListId, product_id: product.id, price: 12.5, tax_rate: 0.16, min_qty: 1 });
    }
    await knex('commercial.stock')
      .insert({ tenant_id: T, warehouse_id: wh.id, product_id: product.id, quantity: 500, reserved_quantity: 0 })
      .onConflict(['tenant_id', 'warehouse_id', 'product_id']).merge(['quantity', 'reserved_quantity']);
    const stockBefore = await knex('commercial.stock').where({ tenant_id: T, warehouse_id: wh.id, product_id: product.id }).first();
    console.log(`  setup: stock q=${stockBefore.quantity} r=${stockBefore.reserved_quantity}`);

    // ── 2. Online: createDraft → addLine → place ──
    console.log('── 2. Online: draft → line → place ──');
    const draft = await req('POST', '/commercial/orders', { customer_id: customer.id, warehouse_id: wh.id, delivery_type: 'route' }, token);
    check('createDraft 201', draft.status === 201 || draft.status === 200, draft.status);
    const orderId = draft.body?.id;
    check('draft.status = draft', draft.body?.status === 'draft', draft.body?.status);
    if (orderId) created.push(orderId);

    const line = await req('POST', `/commercial/orders/${orderId}/lines`, { product_id: product.id, quantity: 5 }, token);
    check('addLine ok', line.status === 201 || line.status === 200, line.status);

    const reservedBefore = Number((await knex('commercial.stock').where({ tenant_id: T, warehouse_id: wh.id, product_id: product.id }).first()).reserved_quantity);

    const placed = await req('POST', `/commercial/orders/${orderId}/place`, { requested_delivery_date: tomorrow() }, token);
    check('place 200/201', placed.status === 201 || placed.status === 200, placed.status);
    check('place → status confirmed', placed.body?.status === 'confirmed', placed.body?.status);

    // ── 3. History: draft → pending_approval → confirmed ──
    console.log('── 3. History ──');
    const hist = await req('GET', `/commercial/orders/${orderId}/history`, null, token);
    const entries = Array.isArray(hist.body) ? hist.body : [];
    const hasPending = entries.some((h) => h.from_status === 'draft' && h.to_status === 'pending_approval');
    const hasConfirmed = entries.some((h) => h.from_status === 'pending_approval' && h.to_status === 'confirmed');
    check('history: draft→pending_approval', hasPending, entries.map((e) => `${e.from_status}->${e.to_status}`));
    check('history: pending_approval→confirmed', hasConfirmed, entries.map((e) => `${e.from_status}->${e.to_status}`));
    const histCount = entries.length;

    // ── 4. Preventa NO reserva stock ──
    console.log('── 4. Stock (preventa no reserva) ──');
    const reservedAfter = Number((await knex('commercial.stock').where({ tenant_id: T, warehouse_id: wh.id, product_id: product.id }).first()).reserved_quantity);
    check('reserved sin cambio (preventa)', reservedAfter === reservedBefore, { reservedBefore, reservedAfter });

    // ── 5. Idempotencia: segundo place ──
    console.log('── 5. Idempotencia ──');
    const placed2 = await req('POST', `/commercial/orders/${orderId}/place`, { requested_delivery_date: tomorrow() }, token);
    check('2do place no falla (idempotente)', placed2.status === 200 || placed2.status === 201, placed2.status);
    check('2do place sigue confirmed', placed2.body?.status === 'confirmed', placed2.body?.status);
    const hist2 = await req('GET', `/commercial/orders/${orderId}/history`, null, token);
    check('history no creció en el 2do place', (Array.isArray(hist2.body) ? hist2.body.length : -1) === histCount, { antes: histCount, despues: hist2.body?.length });

    // ── 6. Replay offline: createDraft → PUT lines → place ──
    console.log('── 6. Replay offline (createDraft → PUT lines → place) ──');
    const draft2 = await req('POST', '/commercial/orders', { customer_id: customer.id, warehouse_id: wh.id, delivery_type: 'route' }, token);
    const orderId2 = draft2.body?.id;
    if (orderId2) created.push(orderId2);
    check('replay: draft creado', !!orderId2, draft2.status);
    const repl = await req('PUT', `/commercial/orders/${orderId2}/lines`, { lines: [{ product_id: product.id, quantity: 3 }] }, token);
    check('replay: PUT lines ok', repl.status === 200 || repl.status === 201, repl.status);
    const placed3 = await req('POST', `/commercial/orders/${orderId2}/place`, { requested_delivery_date: tomorrow() }, token);
    check('replay: place → confirmed', placed3.body?.status === 'confirmed', { status: placed3.status, body: placed3.body?.status });

    exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('FAIL:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  } finally {
    // Cleanup: cancelar los pedidos de prueba (no ensuciar la cartera).
    try {
      for (const id of created) {
        await knex('commercial.order_lines').where({ tenant_id: T, order_id: id }).del();
        await knex('commercial.order_status_history').where({ tenant_id: T, order_id: id }).del();
        await knex('commercial.orders').where({ tenant_id: T, id }).del();
      }
    } catch (cleanErr) { console.warn('cleanup parcial:', cleanErr.message); }
    await knex.destroy();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok / ${fail} fallidos${failures.length ? ` [${failures.join(', ')}]` : ''}`);
    process.exit(exitCode);
  }
})();
