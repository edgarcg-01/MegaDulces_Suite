/* eslint-disable no-console */
/**
 * I.6 — Smoke HTTP de la clasificación ABC (Fase ABC.0).
 *
 * refresh → recomputa; list → shape válido; filtro por clase → solo esa clase.
 * Aserta SHAPE, no proporciones (la data local casi no tiene ventas → casi todo C;
 * en prod con ventas se distribuye ~80/15/5). Ver FASE_ABC_CYCLE_COUNT.md.
 *
 * Requiere API en :3334 con InventoryAbc{Service,Controller} (reiniciar tras ABC.0).
 *   node database/tests/http-inventory-abc-test.js
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

  console.log('\n── 2. Refresh (recompute ABC) ──');
  const refresh = await req('POST', '/commercial/inventory/abc/refresh', { window_days: 90 }, token);
  check('refresh 2xx', refresh.status === 200 || refresh.status === 201, { status: refresh.status });
  const sum = refresh.body || {};
  check('refresh devuelve { classified, window_days, by_class{A,B,C} }',
    typeof sum.classified === 'number' && sum.window_days === 90 &&
    sum.by_class && ['A', 'B', 'C'].every((k) => k in sum.by_class),
    sum);
  console.log(`    classified=${sum.classified} A=${sum.by_class?.A?.count} B=${sum.by_class?.B?.count} C=${sum.by_class?.C?.count}`);

  console.log('\n── 3. List (shape válido) ──');
  const all = await req('GET', '/commercial/inventory/abc', null, token);
  const rows = Array.isArray(all.body) ? all.body : [];
  check('GET /abc devuelve array', Array.isArray(all.body), { status: all.status });
  const validClass = rows.every((r) => ['A', 'B', 'C'].includes(r.abc_class));
  const validShare = rows.every((r) => Number(r.value_share) >= 0 && Number(r.value_share) <= 1.0001);
  const hasWh = rows.every((r) => !!r.warehouse_code);
  check('toda fila: abc_class ∈ {A,B,C}', validClass, { n: rows.length });
  check('toda fila: value_share ∈ [0,1]', validShare);
  check('toda fila trae warehouse_code', hasWh);

  console.log('\n── 4. Filtro por clase ──');
  const onlyA = await req('GET', '/commercial/inventory/abc?abc_class=A', null, token);
  const aRows = Array.isArray(onlyA.body) ? onlyA.body : [];
  check('?abc_class=A → solo clase A (o vacío)', aRows.every((r) => r.abc_class === 'A'), { n: aRows.length });
  const bad = await req('GET', '/commercial/inventory/abc?abc_class=Z', null, token);
  check('?abc_class inválido → 400', bad.status === 400, { status: bad.status });

  console.log(`\n═══ Total: ${pass} pass / ${fail} fail ═══`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(`  - ${f}`)); }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => { console.error('💥 fatal:', err.message); process.exit(1); });
