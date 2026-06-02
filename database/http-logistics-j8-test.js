/* eslint-disable no-console */
/**
 * HTTP E2E test J.8 — Migración desde repo origen.
 *
 * Verifica:
 *   1. State machine extendido (7 estados): programado → checklist_salida →
 *      en_ruta → entregado → checklist_llegada → costos_pendientes → cerrado.
 *      También valida que cerrado dispara fulfill del order asociado.
 *   2. Checklists module: template, create, list, complete con validación de
 *      items required.
 *   3. Photos module: upload con external_url, list por shipment, soft-delete.
 *   4. Reports module: KPI JSON + PDF (verifica Content-Type application/pdf).
 *
 * Requisitos:
 *   - API en :3334 con ENABLE_MULTITENANT=true
 *   - Importer logistics_baseline.js ya corrido (destinos + periodos + config)
 *
 * Correr: node database/http-logistics-j8-test.js
 */

const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token, expectBinary) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (expectBinary) {
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, contentType: r.headers.get('content-type'), bytes: buf.length };
  }
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  // 1. Login
  console.log('── 1. Login ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) {
    console.error('No se pudo loguear. Verifica API en :3334 y credenciales.');
    process.exit(1);
  }

  // 2. Setup: customer TST-0001 (testdata) + warehouse + producto con precio en su price_list
  console.log('\n── 2. Setup data ──');
  const customers = await req('GET', '/commercial/customers?pageSize=50', null, token);
  const allCustomers = customers.body?.data || [];
  const customer = allCustomers.find((c) => c.code === 'TST-0001' && c.active) || allCustomers.find((c) => c.active);
  check('customer activo encontrado', !!customer?.id);

  const warehouses = await req('GET', '/commercial/warehouses', null, token);
  const warehouse = (warehouses.body?.data || warehouses.body || []).find((w) => w.is_default);
  check('warehouse default encontrado', !!warehouse?.id);

  // 3. Crear order draft → confirm → approve
  console.log('\n── 3. Order: draft + lines + confirm + approve ──');
  const draft = await req('POST', '/commercial/orders', {
    customer_id: customer.id, warehouse_id: warehouse.id, notes: 'J.8 test',
  }, token);
  const order = draft.body;
  check('order draft creado', !!order?.id);
  if (!order?.id) { console.error('Cannot continue'); process.exit(1); }

  // Cruzar prices de la price_list del customer con stock del warehouse
  const plPrices = await req('GET', `/commercial/price-lists/${customer.default_price_list_id}/prices?pageSize=200`, null, token);
  const pricedIds = new Set((plPrices.body?.data || []).map((p) => p.product_id));
  const stockResp = await req('GET', `/commercial/inventory/stock?warehouse_id=${warehouse.id}&pageSize=200`, null, token);
  const stockList = stockResp.body?.data || stockResp.body || [];
  const stockEntry = stockList.find((s) => Number(s.quantity || 0) >= 5 && pricedIds.has(s.product_id));
  check('stock entry con qty >= 5 + precio en price_list encontrado', !!stockEntry, { stockCount: stockList.length, pricedCount: pricedIds.size });
  if (!stockEntry) process.exit(1);

  const addLine = await req('POST', `/commercial/orders/${order.id}/lines`, {
    product_id: stockEntry.product_id, quantity: 2,
  }, token);
  check('order line agregada', addLine.status === 201 || addLine.status === 200, addLine);

  const confirm = await req('POST', `/commercial/orders/${order.id}/confirm`, {}, token);
  check('order → pending_approval tras confirm', confirm.body?.status === 'pending_approval', confirm.body?.status);

  const approve = await req('POST', `/commercial/orders/${order.id}/approve`, {}, token);
  check('order → confirmed tras approve', approve.body?.status === 'confirmed', approve.body?.status);

  // 4. Crear shipment ligado al order
  console.log('\n── 4. Shipment ──');
  const shipment = await req('POST', '/logistics/shipments', {
    shipment_date: new Date().toISOString().slice(0, 10),
    order_id: order.id,
    type: 'entrega',
    origin: 'CEDIS Central',
    destination: 'Cliente J8',
  }, token);
  check('shipment programado creado', shipment.body?.status === 'programado', shipment.body?.status);
  const shipId = shipment.body?.id;
  if (!shipId) process.exit(1);

  // 5. State machine: full formal path (7 estados)
  console.log('\n── 5. State machine extendido (formal path) ──');
  let r = await req('POST', `/logistics/shipments/${shipId}/start-salida-checklist`, {}, token);
  check('programado → checklist_salida', r.body?.status === 'checklist_salida', r.body?.status);

  r = await req('POST', `/logistics/shipments/${shipId}/depart`, {}, token);
  check('checklist_salida → en_ruta', r.body?.status === 'en_ruta', r.body?.status);

  r = await req('POST', `/logistics/shipments/${shipId}/deliver`, {}, token);
  check('en_ruta → entregado', r.body?.status === 'entregado', r.body?.status);

  r = await req('POST', `/logistics/shipments/${shipId}/start-llegada-checklist`, {}, token);
  check('entregado → checklist_llegada', r.body?.status === 'checklist_llegada', r.body?.status);

  r = await req('POST', `/logistics/shipments/${shipId}/mark-costs-pending`, {}, token);
  check('checklist_llegada → costos_pendientes', r.body?.status === 'costos_pendientes', r.body?.status);

  // 6. Checklists module
  console.log('\n── 6. Checklists module ──');
  const tplSalida = await req('GET', '/logistics/checklists/template/salida', null, token);
  check('template salida tiene items', Array.isArray(tplSalida.body?.items) && tplSalida.body.items.length > 0);
  check('template salida tiene items required', tplSalida.body?.items?.some?.((i) => i.required) === true);

  const tplLlegada = await req('GET', '/logistics/checklists/template/llegada', null, token);
  check('template llegada tiene items', Array.isArray(tplLlegada.body?.items) && tplLlegada.body.items.length > 0);

  // En este shipment ya está en costos_pendientes, no podemos crear checklist nuevo
  // si ya hay uno. Probamos crear el de salida (idempotencia → ConflictException o new).
  // Necesitamos un shipment NUEVO para probar la creación limpia.
  const ship2 = await req('POST', '/logistics/shipments', {
    shipment_date: new Date().toISOString().slice(0, 10),
    type: 'entrega', origin: 'TEST', destination: 'TEST',
  }, token);
  const ship2Id = ship2.body?.id;
  check('shipment 2 creado para checklist test', !!ship2Id);

  const checklist = await req('POST', '/logistics/checklists', {
    shipment_id: ship2Id,
    type: 'salida',
    items: tplSalida.body.items,
  }, token);
  check('checklist creado', checklist.body?.id && checklist.body?.status === 'pendiente', checklist.body);
  const checklistId = checklist.body?.id;

  // Intentar completar sin todas las requeridas → debe fallar
  const partialComplete = await req('POST', `/logistics/checklists/${checklistId}/complete`, {
    responses: { documentos: { ok: true } }, // solo 1 de varias required
  }, token);
  check('complete con required faltantes rechazado (400)', partialComplete.status === 400);

  // Completar con todas las required
  const responses = {};
  for (const it of tplSalida.body.items) {
    if (it.required) responses[it.id] = { ok: true, comment: 'auto-test' };
  }
  // Agregamos al menos un opcional para cubrir cobertura
  for (const it of tplSalida.body.items) {
    if (!it.required && !responses[it.id]) responses[it.id] = { ok: true };
  }
  const fullComplete = await req('POST', `/logistics/checklists/${checklistId}/complete`, {
    responses, notes: 'OK by E2E',
  }, token);
  check('checklist completado OK', fullComplete.body?.status === 'completado', fullComplete.body);

  const listCl = await req('GET', `/logistics/checklists/shipment/${ship2Id}`, null, token);
  check('list checklists by shipment devuelve 1', Array.isArray(listCl.body) && listCl.body.length === 1);

  // Intentar crear duplicado (unique constraint)
  const dup = await req('POST', '/logistics/checklists', {
    shipment_id: ship2Id, type: 'salida', items: tplSalida.body.items,
  }, token);
  check('duplicado de checklist rechazado (409)', dup.status === 409 || dup.status === 400);

  // 7. Photos module — sin Cloudinary, registramos URL externa
  console.log('\n── 7. Photos module (external_url) ──');
  const photo = await req('POST', '/logistics/photos', {
    shipment_id: ship2Id,
    category: 'loading',
    description: 'E2E test photo',
    external_url: 'https://example.com/test.jpg',
    cloudinary_public_id: 'test/sample',
    gps_lat: 19.4326,
    gps_lng: -99.1332,
  }, token);
  check('photo creada via external_url', photo.body?.id && photo.body?.category === 'loading', photo.body);
  const photoId = photo.body?.id;

  const photosList = await req('GET', `/logistics/photos/shipment/${ship2Id}`, null, token);
  check('list photos by shipment devuelve >=1', Array.isArray(photosList.body) && photosList.body.length >= 1);

  const photosByCategory = await req('GET', `/logistics/photos/shipment/${ship2Id}?category=loading`, null, token);
  check('list photos by category filter funciona', Array.isArray(photosByCategory.body) && photosByCategory.body.length >= 1);

  // Subir foto SIN base64 ni external_url debería fallar
  const badPhoto = await req('POST', '/logistics/photos', {
    shipment_id: ship2Id, category: 'transit',
  }, token);
  check('photo sin imagen rechazada (400)', badPhoto.status === 400);

  // Soft delete
  const delPhoto = await req('DELETE', `/logistics/photos/${photoId}`, null, token);
  check('photo soft-delete OK', delPhoto.body?.deleted === true || delPhoto.status === 200);

  const photosAfter = await req('GET', `/logistics/photos/shipment/${ship2Id}`, null, token);
  const hasDeleted = (photosAfter.body || []).some((p) => p.id === photoId);
  check('photo soft-deleted no aparece en list', !hasDeleted);

  // 8. Reports module
  console.log('\n── 8. Reports module ──');
  const kpi = await req('GET', '/logistics/reports/kpi', null, token);
  check('KPI JSON estructura básica', !!kpi.body?.shipments && !!kpi.body?.financial);
  check('KPI tiene cerrados >= 0', typeof kpi.body?.shipments?.cerrados === 'number');
  check('KPI tiene revenue', typeof kpi.body?.financial?.revenue === 'number');

  const kpiPdf = await req('GET', '/logistics/reports/kpi/pdf', null, token, true);
  check('KPI PDF status 200', kpiPdf.status === 200);
  check('KPI PDF content-type application/pdf', String(kpiPdf.contentType || '').includes('application/pdf'));
  check('KPI PDF tiene bytes', kpiPdf.bytes > 0);

  const shipPdf = await req('GET', `/logistics/reports/shipment/${ship2Id}/pdf`, null, token, true);
  check('Shipment PDF status 200', shipPdf.status === 200);
  check('Shipment PDF content-type application/pdf', String(shipPdf.contentType || '').includes('application/pdf'));
  check('Shipment PDF tiene bytes', shipPdf.bytes > 0);

  // 9. Close shipment 1 → debe fulfillar el order
  console.log('\n── 9. Close shipment con hook a commercial ──');
  r = await req('POST', `/logistics/shipments/${shipId}/close`, {}, token);
  check('costos_pendientes → cerrado', r.body?.status === 'cerrado', r.body?.status);

  const orderAfter = await req('GET', `/commercial/orders/${order.id}`, null, token);
  check('order fulfilled tras cerrar shipment', orderAfter.body?.status === 'fulfilled', orderAfter.body?.status);

  // 10. Cleanup shipment 2
  console.log('\n── 10. Cleanup ──');
  await req('POST', `/logistics/shipments/${ship2Id}/cancel`, { reason: 'E2E cleanup' }, token);
  await req('DELETE', `/logistics/shipments/${ship2Id}`, null, token);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n────── Summary ──────`);
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  if (failures.length) console.log('Failures:', failures);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
