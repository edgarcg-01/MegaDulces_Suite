/* eslint-disable no-console */
/**
 * PA.2 — Smoke HTTP del generador de equipos (plan proporcional).
 *
 * 2 pasillos con cargas distintas → POST /aisles/plan: 1 supervisor por pasillo
 * (S≥n) + contadores proporcionales a unidades (Σ = C, mín por pasillo). Pool
 * sintético (UUIDs random — el algoritmo distribuye ids; nombres null, da igual).
 * Cluster path: con 1 supervisor < 2 pasillos, ambos comparten supervisor + warning.
 *
 * Requiere API en :3334 con generateTeamPlan (reiniciar tras PA.2).
 *   node database/tests/http-inventory-team-plan-test.js
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
  console.log('── 1. Login + setup (2 pasillos con cargas distintas) ──');
  const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  const stock = await req('GET', `/commercial/inventory/stock?pageSize=300`, null, token);
  const rows = stock.body?.data || stock.body || [];
  const byWh = {};
  for (const r of rows) { (byWh[r.warehouse_id] ||= new Set()).add(r.product_id); }
  const whId = Object.keys(byWh).find((w) => byWh[w].size >= 6);
  const pids = whId ? [...byWh[whId]].slice(0, 6) : [];
  check('almacén con ≥6 SKUs', !!whId && pids.length === 6, { n: pids.length });
  if (!whId) process.exit(1);

  const ts = Date.now().toString().slice(-8);
  let aIdA = null, aIdB = null;
  try {
    aIdA = (await req('POST', '/commercial/inventory/aisles', { warehouse_id: whId, code: `TP-A-${ts}`, grid_row: 0, grid_col: 0 }, token)).body?.id;
    aIdB = (await req('POST', '/commercial/inventory/aisles', { warehouse_id: whId, code: `TP-B-${ts}`, grid_row: 0, grid_col: 1 }, token)).body?.id;
    check('2 pasillos creados', !!aIdA && !!aIdB);
    await req('POST', '/commercial/inventory/aisles/assign', { warehouse_id: whId, aisle_id: aIdA, filter: { product_ids: pids.slice(0, 4) } }, token);
    await req('POST', '/commercial/inventory/aisles/assign', { warehouse_id: whId, aisle_id: aIdB, filter: { product_ids: pids.slice(4, 6) } }, token);

    console.log('\n── 2. Plan: 2 supervisores, 6 contadores ──');
    const sup = [randomUUID(), randomUUID()];
    const cnt = Array.from({ length: 6 }, () => randomUUID());
    const plan = await req('POST', '/commercial/inventory/aisles/plan', { warehouse_id: whId, supervisor_ids: sup, counter_ids: cnt, min_counters: 1 }, token);
    check('plan 2xx + basis=units', plan.status === 200 || plan.status === 201, { status: plan.status });
    const items = (plan.body?.plan || []).filter((p) => p.aisle_id === aIdA || p.aisle_id === aIdB);
    check('plan cubre los 2 pasillos', items.length === 2, { n: items.length });
    check('1 supervisor por pasillo (S≥n)', items.every((p) => !!p.supervisor_id), items.map((p) => p.supervisor_id));
    const totalC = items.reduce((s, p) => s + p.counter_count, 0);
    check('Σ contadores = 6 (todo el pool repartido)', totalC === 6, { totalC });
    check('cada pasillo ≥ 1 contador (mínimo)', items.every((p) => p.counter_count >= 1), items.map((p) => p.counter_count));
    const a = items.find((p) => p.aisle_id === aIdA), b = items.find((p) => p.aisle_id === aIdB);
    if (a && b) {
      const heavier = Number(a.units) >= Number(b.units) ? a : b;
      const lighter = heavier === a ? b : a;
      check('el pasillo más pesado (unidades) recibe ≥ contadores que el liviano',
        heavier.counter_count >= lighter.counter_count, { heavy: [heavier.units, heavier.counter_count], light: [lighter.units, lighter.counter_count] });
    } else {
      check('el pasillo más pesado (unidades) recibe ≥ contadores que el liviano', false, { reason: 'plan vacío (endpoint?)' });
    }

    console.log('\n── 3. Cluster: 1 supervisor < 2 pasillos ──');
    const plan1 = await req('POST', '/commercial/inventory/aisles/plan', { warehouse_id: whId, supervisor_ids: [sup[0]], counter_ids: cnt, min_counters: 1 }, token);
    const it1 = (plan1.body?.plan || []).filter((p) => p.aisle_id === aIdA || p.aisle_id === aIdB);
    check('1 supervisor cubre ambos pasillos', it1.length === 2 && it1.every((p) => p.supervisor_id === sup[0]), it1.map((p) => p.supervisor_id));
    check('warning de clusters presente', (plan1.body?.warnings || []).some((w) => /cluster|supervisor/i.test(w)), plan1.body?.warnings);
  } finally {
    if (aIdA) await req('DELETE', `/commercial/inventory/aisles/${aIdA}`, null, token).catch(() => {});
    if (aIdB) await req('DELETE', `/commercial/inventory/aisles/${aIdB}`, null, token).catch(() => {});
  }

  console.log(`\n═══ Total: ${pass} pass / ${fail} fail ═══`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.error('💥 fatal:', err.message); process.exit(1); });
