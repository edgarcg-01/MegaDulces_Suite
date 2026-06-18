/* eslint-disable no-console */
/**
 * I.5 — Smoke HTTP E2E del endurecimiento de correctness del conteo físico.
 *
 * Ejercita los 3 fixes P0 contra los endpoints REALES (no DB-direct):
 *   A4 — segregación del 3er conteo: count_3 del mismo contador → 409.
 *   A2 — computeDiscrepancies NO revierte resoluciones manuales (override sobrevive).
 *   A1 — freeze integrity guard: folio sin congelar + movimiento → reconcile 409.
 *
 * Auto-contenido: crea un almacén dedicado de 1 SKU (modo commercial) para que
 * A1/A2 sean testeables con un solo usuario sin contar todo un almacén real, y
 * para NO congelar MD-CENTRAL (rompería los smokes de pedidos). Cancela sus
 * folios en teardown.
 *
 * Requisitos: API en :3334 con el código de inventory-count.service ACTUALIZADO
 * (commit del P0). Si la API corre código viejo, A1/A2/A4 fallan → reiniciar API.
 *
 * Correr: node database/tests/http-inventory-count-test.js
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
  // 1. Login
  console.log('── 1. Login ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  // 2. Producto válido (de cualquier stock existente) + almacén dedicado
  console.log('\n── 2. Setup (almacén dedicado de 1 SKU, modo commercial) ──');
  const whs = await req('GET', '/commercial/warehouses', null, token);
  const defWh = (whs.body?.data || whs.body || []).find((w) => w.is_default) || (whs.body?.data || whs.body || [])[0];
  check('warehouse default existe', !!defWh?.id);
  const stock = await req('GET', `/commercial/inventory/stock?warehouse_id=${defWh.id}&pageSize=5`, null, token);
  const productId = (stock.body?.data || stock.body || [])[0]?.product_id;
  check('product_id de muestra obtenido', !!productId, { defWh: defWh?.code });
  if (!productId) { console.error('  ⚠️ Sin stock de muestra para tomar un product_id.'); process.exit(1); }

  const ts = Date.now().toString().slice(-8);
  const created = await req('POST', '/commercial/warehouses', {
    code: `INVCNT-${ts}`, name: `Test Conteo ${ts}`, is_default: false,
  }, token);
  const whId = created.body?.id;
  check('almacén de test creado', !!whId, created.body);
  if (!whId) process.exit(1);

  // stock inicial 100 en el almacén de test
  const seed = await req('POST', '/commercial/inventory/movements', {
    warehouse_id: whId, product_id: productId, movement_type: 'in', quantity: 100, reference_type: 'test-seed',
  }, token);
  check('stock inicial 100 sembrado', seed.status === 201 || seed.status === 200, seed.body);

  const vr = await req('GET', '/commercial/inventory/counts/variance-reasons', null, token);
  check('catálogo de motivos de varianza disponible (incluye caducado)',
    vr.status === 200 && Array.isArray(vr.body) && vr.body.some((r) => r.code === 'caducado'),
    { status: vr.status, n: Array.isArray(vr.body) ? vr.body.length : null });

  const ira = await req('GET', '/commercial/inventory/counts/ira', null, token);
  check('endpoint IRA responde con shape (ira_pct + by_reason + recent_folios)',
    ira.status === 200 && ('ira_pct' in (ira.body || {})) && Array.isArray(ira.body?.by_reason) && Array.isArray(ira.body?.recent_folios),
    { status: ira.status });

  // P2.1b — captura de lote/caducidad en recepción + lectura de lotes (FEFO)
  const expDate = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const lotMv = await req('POST', '/commercial/inventory/movements', {
    warehouse_id: whId, product_id: productId, movement_type: 'in', quantity: 10, lot_code: 'LOT-SMOKE', expiry_date: expDate,
  }, token);
  check('P2.1b: recepción con lote+caducidad aceptada', lotMv.status === 201 || lotMv.status === 200, { status: lotMv.status });
  const lots = await req('GET', `/commercial/inventory/stock/${whId}/${productId}/lots`, null, token);
  const lotArr = Array.isArray(lots.body) ? lots.body : (Array.isArray(lots.body?.data) ? lots.body.data : []);
  const lotRow = lotArr.find((l) => l.lot_code === 'LOT-SMOKE');
  check('P2.1b: lote real capturado (qty 10 + caducidad)', !!lotRow && Number(lotRow.quantity) === 10 && !!lotRow.expiry_date, { status: lots.status, body: lots.body });

  // P2.2 — el lote (+60d) aparece en /expiring con ventana amplia, no con ventana corta
  const expWide = await req('GET', `/commercial/inventory/expiring?days=90&warehouse_id=${whId}`, null, token);
  const wideArr = Array.isArray(expWide.body) ? expWide.body : [];
  check('P2.2: lote a +60d aparece en /expiring?days=90', wideArr.some((l) => l.lot_code === 'LOT-SMOKE'), { status: expWide.status, n: wideArr.length });
  const expNarrow = await req('GET', `/commercial/inventory/expiring?days=30&warehouse_id=${whId}`, null, token);
  const narrowArr = Array.isArray(expNarrow.body) ? expNarrow.body : [];
  check('P2.2: lote a +60d NO aparece en /expiring?days=30', expNarrow.status === 200 && !narrowArr.some((l) => l.lot_code === 'LOT-SMOKE'), { status: expNarrow.status, n: narrowArr.length });

  let openFolio = null;
  const cancel = async (id) => { if (id) await req('POST', `/commercial/inventory/counts/${id}/cancel`, { reason: 'smoke teardown' }, token); };

  try {
    // ── A4: segregación del 3er conteo ──
    console.log('\n── 3. A4 · count_3 del mismo contador → 409 ──');
    let f = await req('POST', '/commercial/inventory/counts/open', { warehouse_id: whId }, token);
    openFolio = f.body?.id;
    check('folio A4 abierto', !!openFolio, f.body);
    const c1 = await req('POST', `/commercial/inventory/counts/${openFolio}/count`, { product_id: productId, quantity: 100 }, token);
    check('count_1 registrado', c1.status === 201 && c1.body?.slot === 'count_1', c1.body);
    const c3 = await req('POST', `/commercial/inventory/counts/${openFolio}/count`, { product_id: productId, quantity: 100, recount: true }, token);
    check('A4: count_3 del mismo contador RECHAZADO (409)', c3.status === 409, { status: c3.status, body: c3.body });
    await cancel(openFolio); openFolio = null;

    // ── A2: re-compute no revierte la resolución manual ──
    console.log('\n── 4. A2 · override de supervisor sobrevive a re-compute ──');
    f = await req('POST', '/commercial/inventory/counts/open', { warehouse_id: whId, blind_double_count: false }, token);
    openFolio = f.body?.id;
    check('folio A2 abierto (blind=false)', !!openFolio, f.body);
    await req('POST', `/commercial/inventory/counts/${openFolio}/count`, { product_id: productId, quantity: 90 }, token);
    const adv = await req('POST', `/commercial/inventory/counts/${openFolio}/advance-pass`, {}, token);
    check('advance-pass → review', adv.body?.status === 'review', adv.body);
    await req('POST', `/commercial/inventory/counts/${openFolio}/compute`, {}, token);
    let items = await req('GET', `/commercial/inventory/counts/${openFolio}/items`, null, token);
    let item = (items.body?.data || items.body || []).find((i) => i.product_id === productId);
    check('item resuelto por compute (final=90)', Number(item?.final_qty) === 90, item);
    const itemId = item?.id;
    await req('POST', `/commercial/inventory/counts/${openFolio}/items/${itemId}/resolve`, { final_qty: 95, notes: 'override smoke', reason_code: 'merma' }, token);
    await req('POST', `/commercial/inventory/counts/${openFolio}/compute`, {}, token); // re-compute
    items = await req('GET', `/commercial/inventory/counts/${openFolio}/items`, null, token);
    item = (items.body?.data || items.body || []).find((i) => i.product_id === productId);
    check('A2: override (95) sobrevive al re-compute (no revierte a 90)', Number(item?.final_qty) === 95, item);
    check('A2: item sigue resolved tras re-compute', item?.status === 'resolved', { status: item?.status });
    check('reason-codes: clasificación (merma) persiste tras re-compute', item?.reason_code === 'merma', { reason_code: item?.reason_code });
    await cancel(openFolio); openFolio = null;

    // ── A1: freeze integrity guard ──
    console.log('\n── 5. A1 · folio sin congelar + movimiento → reconcile 409 ──');
    f = await req('POST', '/commercial/inventory/counts/open', { warehouse_id: whId, freeze_movements: false, blind_double_count: false }, token);
    openFolio = f.body?.id;
    check('folio A1 abierto (freeze=false)', !!openFolio, f.body);
    // movimiento DESPUÉS de abrir (permitido porque NO está congelado)
    const mv = await req('POST', '/commercial/inventory/movements', {
      warehouse_id: whId, product_id: productId, movement_type: 'in', quantity: 5, reference_type: 'test-move',
    }, token);
    check('movimiento durante folio no-congelado permitido', mv.status === 201 || mv.status === 200, { status: mv.status });
    await req('POST', `/commercial/inventory/counts/${openFolio}/count`, { product_id: productId, quantity: 100 }, token);
    await req('POST', `/commercial/inventory/counts/${openFolio}/advance-pass`, {}, token);
    await req('POST', `/commercial/inventory/counts/${openFolio}/compute`, {}, token);
    const rec = await req('POST', `/commercial/inventory/counts/${openFolio}/reconcile`, {}, token);
    check('A1: reconcile BLOQUEADO por movimiento sin congelar (409)', rec.status === 409, { status: rec.status, body: rec.body });
    check('A1: el mensaje explica el motivo (movimiento/congelar)', /movimiento|congel/i.test(JSON.stringify(rec.body || '')), rec.body);
    await cancel(openFolio); openFolio = null;

    // ── T: count-back por tolerancia (umbral de recuento) ──
    console.log('\n── 6. T · conteos coinciden pero fuera de tolerancia → discrepancy (no auto-resuelve) ──');
    f = await req('POST', '/commercial/inventory/counts/open', { warehouse_id: whId, blind_double_count: false, recount_threshold_pct: 10 }, token);
    openFolio = f.body?.id;
    check('folio T abierto (umbral 10%)', !!openFolio, f.body);
    await req('POST', `/commercial/inventory/counts/${openFolio}/count`, { product_id: productId, quantity: 1 }, token); // muy lejos del teórico (~100)
    await req('POST', `/commercial/inventory/counts/${openFolio}/advance-pass`, {}, token);
    await req('POST', `/commercial/inventory/counts/${openFolio}/compute`, {}, token);
    const tItems = await req('GET', `/commercial/inventory/counts/${openFolio}/items`, null, token);
    const tItem = (tItems.body?.data || tItems.body || []).find((i) => i.product_id === productId);
    check('count-back: conteo fuera de tolerancia → discrepancy (NO auto-resuelto)', tItem?.status === 'discrepancy' && tItem?.final_qty == null, { status: tItem?.status, final_qty: tItem?.final_qty });
    await cancel(openFolio); openFolio = null;
  } finally {
    await cancel(openFolio);
    // soft-delete del almacén de test (best-effort)
    if (whId) await req('DELETE', `/commercial/warehouses/${whId}`, null, token).catch(() => {});
  }

  console.log(`\n═══ Total: ${pass} pass / ${fail} fail ═══`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('💥 fatal:', err.message, err.stack);
  process.exit(1);
});
