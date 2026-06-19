/* eslint-disable no-console */
/**
 * PA.1 — Smoke HTTP de pasillos (layout) + mapeo bulk SKU→pasillo.
 *
 * Crea pasillos, asigna SKUs por lista, verifica carga (unidades/#SKUs), valida
 * el guard de filtro y el borrado (SET NULL). Acotado a 3 SKUs reales de un
 * almacén; los des-asigna en teardown (borrar el pasillo → SET NULL).
 *
 * Requiere API en :3334 con WarehouseAisles{Service,Controller} (reiniciar tras PA.1a).
 *   node database/tests/http-inventory-aisles-test.js
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

  // almacén con ≥3 productos + 3 product_ids de ESE almacén
  const stock = await req('GET', `/commercial/inventory/stock?pageSize=200`, null, token);
  const rows = stock.body?.data || stock.body || [];
  const byWh = {};
  for (const r of rows) { (byWh[r.warehouse_id] ||= new Set()).add(r.product_id); }
  const whId = Object.keys(byWh).find((w) => byWh[w].size >= 3);
  const prodIds = whId ? [...byWh[whId]].slice(0, 3) : [];
  check('almacén con ≥3 SKUs + 3 product_ids', !!whId && prodIds.length === 3, { whId, n: prodIds.length });
  if (!whId) process.exit(1);

  const ts = Date.now().toString().slice(-8);
  let aisleId = null;
  try {
    console.log('\n── 2. Crear pasillo (posición 2D) ──');
    const created = await req('POST', '/commercial/inventory/aisles', { warehouse_id: whId, code: `PA-${ts}`, name: 'Pasillo Test', grid_row: 0, grid_col: 0 }, token);
    aisleId = created.body?.id;
    check('pasillo creado con id + grid', !!aisleId && created.body?.grid_row === 0, { status: created.status, body: created.body });
    const dup = await req('POST', '/commercial/inventory/aisles', { warehouse_id: whId, code: `PA-${ts}` }, token);
    check('código duplicado → 409', dup.status === 409, { status: dup.status });

    console.log('\n── 3. Mapeo bulk SKU→pasillo (por lista) ──');
    const assign = await req('POST', '/commercial/inventory/aisles/assign', { warehouse_id: whId, aisle_id: aisleId, filter: { product_ids: prodIds } }, token);
    check('assign por product_ids → updated=3', assign.body?.updated === 3, { body: assign.body });
    const noFilter = await req('POST', '/commercial/inventory/aisles/assign', { warehouse_id: whId, aisle_id: aisleId, filter: {} }, token);
    check('assign sin filtro → 400', noFilter.status === 400, { status: noFilter.status });

    console.log('\n── 4. Listar pasillos + carga ──');
    const list = await req('GET', `/commercial/inventory/aisles?warehouse_id=${whId}`, null, token);
    const a = (list.body?.aisles || []).find((x) => x.id === aisleId);
    check('pasillo aparece con sku_count=3', !!a && Number(a.sku_count) === 3, { a });
    check('carga en unidades > 0', !!a && Number(a.units) > 0, { units: a?.units });
    check('bucket "Sin pasillo" presente', typeof list.body?.unassigned?.sku_count === 'number', { unassigned: list.body?.unassigned });

    console.log('\n── 5. Editar + borrar (SET NULL) ──');
    const upd = await req('PATCH', `/commercial/inventory/aisles/${aisleId}`, { name: 'Renombrado', grid_col: 2 }, token);
    check('editar pasillo (nombre/posición)', upd.body?.name === 'Renombrado' && upd.body?.grid_col === 2, { body: upd.body });
    const del = await req('DELETE', `/commercial/inventory/aisles/${aisleId}`, null, token);
    check('borrar pasillo → ok (SET NULL en stock)', del.body?.ok === true, { status: del.status, body: del.body });
    aisleId = null;
    // tras borrar, los 3 SKUs vuelven a "Sin pasillo"
    const list2 = await req('GET', `/commercial/inventory/aisles?warehouse_id=${whId}`, null, token);
    check('pasillo ya no aparece tras borrar', !(list2.body?.aisles || []).some((x) => x.code === `PA-${ts}`), {});
  } finally {
    if (aisleId) await req('DELETE', `/commercial/inventory/aisles/${aisleId}`, null, token).catch(() => {});
  }

  console.log(`\n═══ Total: ${pass} pass / ${fail} fail ═══`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.error('💥 fatal:', err.message); process.exit(1); });
