/* eslint-disable no-console */
/**
 * I.7 — ABC.2 conteo cíclico ACOTADO (open-cycle).
 *
 * Verifica que un folio cíclico cuenta SOLO el subset pedido (no todo el almacén):
 *   - por clase ABC  → folio con los productos de esa clase.
 *   - por lista       → folio con exactamente esos productos.
 *   - scheduler (ABC.3) → generate-cycle-folios crea 1 folio + anti-duplicado.
 * Almacén dedicado de 3 SKUs (sin ventas → los 3 caen en C tras refresh ABC).
 *
 * Requiere API en :3334 con openCycleCount + openCount(product_ids) (reiniciar tras ABC.2).
 *   node database/tests/http-inventory-cycle-count-test.js
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
  console.log('── 1. Login + setup ──');
  const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  // 3 product_id distintos de cualquier stock existente (para recibirlos al dedicado).
  const stock = await req('GET', `/commercial/inventory/stock?pageSize=50`, null, token);
  const allPids = (stock.body?.data || stock.body || []).map((s) => s.product_id).filter(Boolean);
  const prodIds = [...new Set(allPids)].slice(0, 3);
  check('3 product_id de muestra', prodIds.length === 3, { got: prodIds.length });
  if (prodIds.length < 3) process.exit(1);

  const ts = Date.now().toString().slice(-8);
  const created = await req('POST', '/commercial/warehouses', { code: `INVCYC-${ts}`, name: `Test Ciclico ${ts}`, is_default: false }, token);
  const whId = created.body?.id;
  check('almacén dedicado creado', !!whId, created.body);
  if (!whId) process.exit(1);

  for (const pid of prodIds) {
    await req('POST', '/commercial/inventory/movements', { warehouse_id: whId, product_id: pid, movement_type: 'in', quantity: 50 }, token);
  }
  const refresh = await req('POST', '/commercial/inventory/abc/refresh', { window_days: 90 }, token);
  check('ABC refresh 2xx', refresh.status === 200 || refresh.status === 201, { status: refresh.status });

  const cancel = async (id) => { if (id) await req('POST', `/commercial/inventory/counts/${id}/cancel`, { reason: 'smoke teardown' }, token); };

  try {
    console.log('\n── 2. open-cycle por CLASE (C) → folio acotado a la clase ──');
    const byClass = await req('POST', '/commercial/inventory/counts/open-cycle', { warehouse_id: whId, abc_class: 'C' }, token);
    check('open-cycle abc_class=C 2xx', byClass.status === 201 || byClass.status === 200, { status: byClass.status, body: byClass.body });
    check('folio cíclico tipo=cycle', byClass.body?.type === 'cycle', { type: byClass.body?.type });
    check('cíclico NO congela el almacén (freeze=false)', byClass.body?.freeze_movements === false, { freeze: byClass.body?.freeze_movements });
    check('expected_items = 3 (los 3 SKUs clase C del almacén)', byClass.body?.expected_items === 3, { expected: byClass.body?.expected_items });
    await cancel(byClass.body?.id);

    console.log('\n── 3. open-cycle por LISTA → solo esos productos ──');
    const subset = prodIds.slice(0, 2);
    const byList = await req('POST', '/commercial/inventory/counts/open-cycle', { warehouse_id: whId, product_ids: subset }, token);
    check('open-cycle product_ids 2xx', byList.status === 201 || byList.status === 200, { status: byList.status });
    check('expected_items = 2 (solo el subset, NO todo el almacén)', byList.body?.expected_items === 2, { expected: byList.body?.expected_items });
    const items = await req('GET', `/commercial/inventory/counts/${byList.body?.id}/items`, null, token);
    const itemArr = Array.isArray(items.body) ? items.body : (Array.isArray(items.body?.data) ? items.body.data : []);
    const itemPids = itemArr.map((i) => i.product_id);
    check('los items del folio son exactamente el subset', itemArr.length === 2 && itemPids.every((p) => subset.includes(p)), { n: itemArr.length });
    await cancel(byList.body?.id);

    console.log('\n── 4. Validación: sin clase ni lista → 400 ──');
    const bad = await req('POST', '/commercial/inventory/counts/open-cycle', { warehouse_id: whId }, token);
    check('open-cycle sin abc_class ni product_ids → 400', bad.status === 400, { status: bad.status });

    console.log('\n── 5. Scheduler (ABC.3): generate-cycle-folios + anti-duplicado ──');
    const gen = await req('POST', '/commercial/inventory/abc/generate-cycle-folios', { warehouse_id: whId }, token);
    check('generate 2xx', gen.status === 200 || gen.status === 201, { status: gen.status });
    check('generó 1 folio (almacén con items due)', gen.body?.folios_created === 1 && gen.body?.warehouses_due === 1, gen.body);
    const gen2 = await req('POST', '/commercial/inventory/abc/generate-cycle-folios', { warehouse_id: whId }, token);
    check('re-generar → skipped=1, created=0 (anti-duplicado)', gen2.body?.skipped === 1 && gen2.body?.folios_created === 0, gen2.body);
    const folios = await req('GET', `/commercial/inventory/counts?warehouse_id=${whId}`, null, token);
    const folioArr = Array.isArray(folios.body) ? folios.body : (Array.isArray(folios.body?.data) ? folios.body.data : []);
    const open = folioArr.find((f) => f.status === 'counting' && f.type === 'cycle');
    check('hay 1 folio cíclico abierto auto-generado', !!open, { n: folioArr.length });
    await cancel(open?.id);
  } finally {
    if (whId) await req('DELETE', `/commercial/warehouses/${whId}`, null, token).catch(() => {});
  }

  console.log(`\n═══ Total: ${pass} pass / ${fail} fail ═══`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.error('💥 fatal:', err.message); process.exit(1); });
