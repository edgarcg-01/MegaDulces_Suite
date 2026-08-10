/* eslint-disable no-console */
/**
 * P2.6 — Smoke HTTP E2E del Control de Caducidades (inspección de anaquel digital).
 *
 * Ejercita el flujo real contra los endpoints (:3334), no DB-direct:
 *   - crear hoja (draft) para un almacén dedicado,
 *   - agregar renglón CON producto + caducidad + cantidad (alimenta FEFO),
 *   - agregar renglón SIN producto (solo raw, NO alimenta FEFO),
 *   - subir "foto" (se adjunta un ReviewFile directo en el renglón — sin depender
 *     de Cloudinary; el endpoint /upload se prueba aparte de forma tolerante),
 *   - enviar la hoja y verificar:
 *       (1) el renglón con caducidad aparece en /commercial/inventory/expiring,
 *       (2) commercial.stock.quantity NO cambió (invariante SUM(lotes)=stock),
 *       (3) fed_lines = 1 (solo el renglón con producto+caducidad),
 *       (4) re-enviar → 409.
 *
 * Requiere API en :3334 con el código de commercial-expiry-reviews.
 * Correr: node database/tests/http-expiry-reviews-test.js
 */

const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  console.log('── 1. Login ──');
  const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  console.log('\n── 2. Setup (almacén dedicado + stock 100) ──');
  const whs = await req('GET', '/commercial/warehouses', null, token);
  const defWh = (whs.body?.data || whs.body || []).find((w) => w.is_default) || (whs.body?.data || whs.body || [])[0];
  const stock = await req('GET', `/commercial/inventory/stock?warehouse_id=${defWh.id}&pageSize=5`, null, token);
  const productId = (stock.body?.data || stock.body || [])[0]?.product_id;
  check('product_id de muestra obtenido', !!productId);
  if (!productId) process.exit(1);

  const ts = Date.now().toString().slice(-8);
  const created = await req('POST', '/commercial/warehouses', { code: `EXPREV-${ts}`, name: `Test Caducidades ${ts}`, is_default: false }, token);
  const whId = created.body?.id;
  check('almacén de test creado', !!whId, created.body);
  if (!whId) process.exit(1);

  const seed = await req('POST', '/commercial/inventory/movements', { warehouse_id: whId, product_id: productId, movement_type: 'in', quantity: 100, reference_type: 'test-seed' }, token);
  check('stock inicial 100 sembrado', seed.status === 201 || seed.status === 200, seed.body);

  const stockBefore = await req('GET', `/commercial/inventory/stock/${whId}/${productId}`, null, token);
  const qtyBefore = Number(stockBefore.body?.quantity ?? 0);
  check('stock inicial = 100', qtyBefore === 100, { qtyBefore });

  console.log('\n── 3. Crear hoja + renglones ──');
  const review = await req('POST', '/commercial/expiry-reviews', { warehouse_id: whId, notes: 'Smoke P2.6', default_location: 'Anaquel 3' }, token);
  const reviewId = review.body?.id;
  check('hoja creada (draft)', !!reviewId && review.body?.status === 'draft', review.body);
  check('hoja guardó default_location', review.body?.default_location === 'Anaquel 3', review.body?.default_location);
  if (!reviewId) process.exit(1);

  const expDate = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString().slice(0, 10); // vence en 20 días
  const line1 = await req('POST', `/commercial/expiry-reviews/${reviewId}/lines`, {
    product_id: productId, product_code_raw: 'SMOKE-1', quantity: 10, expiry_date: expDate,
    condition: 'regular', observations: 'se ve dura', action: 'promocionar', location: 'Anaquel 3',
    files: [{ role: 'evidencia', url: 'https://example.test/foto.jpg', kind: 'image' }],
  }, token);
  check('renglón 1 (producto+caducidad+foto+ubicación) agregado', line1.status === 201 || line1.status === 200, line1.body);
  check('renglón 1 guardó location', line1.body?.location === 'Anaquel 3', line1.body?.location);

  const line2 = await req('POST', `/commercial/expiry-reviews/${reviewId}/lines`, {
    product_code_raw: '99999', product_name_raw: 'Producto sin match', quantity: 5, condition: 'malo', observations: 'no tiene fecha',
  }, token);
  check('renglón 2 (sin producto, solo raw) agregado', line2.status === 201 || line2.status === 200, line2.body);

  const detail = await req('GET', `/commercial/expiry-reviews/${reviewId}`, null, token);
  check('detalle trae 2 renglones', (detail.body?.lines || []).length === 2, { n: (detail.body?.lines || []).length });
  check('renglón 1 guardó la foto en files jsonb', (detail.body?.lines || []).some((l) => (l.files || []).length === 1));

  console.log('\n── 4. Endpoint /upload (tolerante a falta de Cloudinary) ──');
  const upload = await req('POST', '/commercial/expiry-reviews/upload', { file_base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', role: 'evidencia' }, token);
  if (upload.status === 200 || upload.status === 201) check('upload devolvió url', !!upload.body?.url, upload.body);
  else { console.log(`  SKIP upload (Cloudinary no configurado local, status ${upload.status})`); }

  console.log('\n── 5. Enviar hoja → alimenta FEFO ──');
  const submit = await req('POST', `/commercial/expiry-reviews/${reviewId}/submit`, {}, token);
  check('submit OK (status submitted)', submit.body?.status === 'submitted', submit.body);
  check('fed_lines = 1 (solo el renglón con producto+caducidad)', submit.body?.fed_lines === 1, { fed_lines: submit.body?.fed_lines });

  const expiring = await req('GET', `/commercial/inventory/expiring?days=60&warehouse_id=${whId}`, null, token);
  const lot = (expiring.body || []).find((l) => l.product_id === productId && Number(l.quantity) === 10);
  check('el lote fechado aparece en /expiring con qty 10', !!lot, { rows: (expiring.body || []).length });
  check('el lote fechado tiene la caducidad capturada', lot?.expiry_date?.slice(0, 10) === expDate, { got: lot?.expiry_date });

  const stockAfter = await req('GET', `/commercial/inventory/stock/${whId}/${productId}`, null, token);
  const qtyAfter = Number(stockAfter.body?.quantity ?? -1);
  check('INVARIANTE: stock.quantity NO cambió (sigue 100)', qtyAfter === qtyBefore, { qtyBefore, qtyAfter });

  const detail2 = await req('GET', `/commercial/expiry-reviews/${reviewId}`, null, token);
  const l1 = (detail2.body?.lines || []).find((l) => l.product_id === productId);
  const l2 = (detail2.body?.lines || []).find((l) => !l.product_id);
  check('renglón 1 marcado fed_to_fefo con fefo_qty=10', l1?.fed_to_fefo === true && Number(l1?.fefo_qty) === 10, { l1 });
  check('renglón 2 (sin producto) NO alimentó FEFO', l2?.fed_to_fefo === false, { l2 });

  console.log('\n── 6. Reglas de estado ──');
  const resubmit = await req('POST', `/commercial/expiry-reviews/${reviewId}/submit`, {}, token);
  check('re-enviar hoja enviada → 409', resubmit.status === 409, { status: resubmit.status });
  const addAfter = await req('POST', `/commercial/expiry-reviews/${reviewId}/lines`, { product_code_raw: 'X', quantity: 1 }, token);
  check('agregar renglón a hoja enviada → 409', addAfter.status === 409, { status: addAfter.status });

  console.log(`\n──────────\n  ${pass} OK · ${fail} FAIL`);
  if (fail) { console.log('  Fallas:', failures.join(', ')); process.exit(1); }
  console.log('  ✅ P2.6 Control de Caducidades verde.');
})().catch((e) => { console.error(e); process.exit(1); });
