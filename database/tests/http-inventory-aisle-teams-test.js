/* eslint-disable no-console */
/**
 * PA.3 — Smoke HTTP del tablero de equipos por folio (staffing por pasillo).
 *
 * Almacén dedicado + 2 pasillos (2 SKUs c/u) + folio abierto → board, auto-generar
 * (parejo), set manual. user_id sin FK → pool sintético (UUIDs random). Cancela el
 * folio + borra pasillos/almacén en teardown.
 *
 * Requiere API en :3334 con InventoryTeam{Service,Controller} (reiniciar tras PA.3).
 *   node database/tests/http-inventory-aisle-teams-test.js
 */
const { randomUUID } = require('crypto');
const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0;
const failures = [];

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
  console.log('── 1. Login + setup (almacén dedicado, 2 pasillos, folio) ──');
  const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  const stock = await req('GET', '/commercial/inventory/stock?pageSize=50', null, token);
  const pids = [...new Set((stock.body?.data || stock.body || []).map((s) => s.product_id).filter(Boolean))].slice(0, 4);
  check('4 product_id de muestra', pids.length === 4, { n: pids.length });
  if (pids.length < 4) process.exit(1);

  const ts = Date.now().toString().slice(-8);
  const wh = await req('POST', '/commercial/warehouses', { code: `TEAMWH-${ts}`, name: `Team WH ${ts}`, is_default: false }, token);
  const whId = wh.body?.id;
  for (const p of pids) await req('POST', '/commercial/inventory/movements', { warehouse_id: whId, product_id: p, movement_type: 'in', quantity: 20 }, token);
  const aA = (await req('POST', '/commercial/inventory/aisles', { warehouse_id: whId, code: `A-${ts}`, grid_row: 0, grid_col: 0 }, token)).body?.id;
  const aB = (await req('POST', '/commercial/inventory/aisles', { warehouse_id: whId, code: `B-${ts}`, grid_row: 0, grid_col: 1 }, token)).body?.id;
  await req('POST', '/commercial/inventory/aisles/assign', { warehouse_id: whId, aisle_id: aA, filter: { product_ids: pids.slice(0, 2) } }, token);
  await req('POST', '/commercial/inventory/aisles/assign', { warehouse_id: whId, aisle_id: aB, filter: { product_ids: pids.slice(2, 4) } }, token);
  const folio = await req('POST', '/commercial/inventory/counts/open', { warehouse_id: whId, freeze_movements: false }, token);
  const countId = folio.body?.id;
  check('folio + 2 pasillos creados', !!whId && !!aA && !!aB && !!countId, { whId, aA, aB, countId });

  try {
    console.log('\n── 2. Board inicial (sin equipos) ──');
    const b0 = await req('GET', `/commercial/inventory/counts/${countId}/aisle-teams`, null, token);
    const ais0 = b0.body?.aisles || [];
    check('board lista 2 pasillos', ais0.length === 2, { n: ais0.length });
    check('sin supervisor/contadores aún', ais0.every((a) => !a.supervisor && a.counters.length === 0), {});

    console.log('\n── 3. Auto-generar (parejo): 2 sup, 4 contadores ──');
    const sup = [randomUUID(), randomUUID()];
    const cnt = Array.from({ length: 4 }, () => randomUUID());
    const gen = await req('POST', `/commercial/inventory/counts/${countId}/generate-teams`, { supervisor_ids: sup, counter_ids: cnt }, token);
    check('generate 2xx', gen.status === 200 || gen.status === 201, { status: gen.status });
    const t = gen.body?.teams || [];
    check('1 supervisor por pasillo', t.length === 2 && t.every((a) => !!a.supervisor), t.map((a) => a.supervisor?.user_id));
    check('contadores parejos (2 + 2)', t.every((a) => a.counters.length === 2), t.map((a) => a.counters.length));

    console.log('\n── 4. Set manual (mover contadores a un pasillo) ──');
    const set = await req('POST', `/commercial/inventory/counts/${countId}/aisle-teams`, {
      teams: [
        { aisle_id: aA, supervisor_id: sup[0], counter_ids: cnt },        // los 4 a A
        { aisle_id: aB, supervisor_id: sup[1], counter_ids: [] },          // B sin contadores
      ],
    }, token);
    const tm = set.body?.teams || [];
    const ta = tm.find((a) => a.aisle_id === aA), tb = tm.find((a) => a.aisle_id === aB);
    check('set manual aplicado (A=4, B=0)', ta?.counters.length === 4 && tb?.counters.length === 0, { a: ta?.counters.length, b: tb?.counters.length });
  } finally {
    if (countId) await req('POST', `/commercial/inventory/counts/${countId}/cancel`, { reason: 'smoke teardown' }, token).catch(() => {});
    if (aA) await req('DELETE', `/commercial/inventory/aisles/${aA}`, null, token).catch(() => {});
    if (aB) await req('DELETE', `/commercial/inventory/aisles/${aB}`, null, token).catch(() => {});
    if (whId) await req('DELETE', `/commercial/warehouses/${whId}`, null, token).catch(() => {});
  }

  console.log(`\n═══ Total: ${pass} pass / ${fail} fail ═══`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.error('💥 fatal:', err.message); process.exit(1); });
