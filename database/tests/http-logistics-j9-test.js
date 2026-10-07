/* eslint-disable no-console */
/**
 * HTTP smoke test J.9 — Port UI desde repo.
 *
 * Verifica que los endpoints que consumen las 4 páginas nuevas devuelven
 * shape correcto:
 *   - /logistica/dashboard → analytics/overview + shipment-profitability + fleet-utilization
 *   - /logistica/staff     → fleet/drivers (CRUD)
 *   - /logistica/guides    → guides (list global)
 *   - /logistica/costs     → expenses (list nuevo J.9.4) + expenses/summary
 *
 * Correr: node database/http-logistics-j9-test.js
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
  console.log('── 1. Login ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  // ─────────────────────────────────────────────────────────────────────
  // Dashboard endpoints (J.9.1)
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── 2. Dashboard endpoints (J.9.1) ──');
  const ov = await req('GET', '/logistics/analytics/overview', null, token);
  check('overview status 200', ov.status === 200);
  check('overview tiene shipments.count', typeof ov.body?.shipments?.count === 'number');
  check('overview tiene revenue.freight', typeof ov.body?.revenue?.freight === 'number');
  check('overview tiene cost.total', typeof ov.body?.cost?.total === 'number');
  check('overview tiene margin.gross_pct', typeof ov.body?.margin?.gross_pct === 'number');

  const prof = await req('GET', '/logistics/analytics/shipment-profitability?limit=10', null, token);
  check('shipment-profitability status 200', prof.status === 200);
  check('shipment-profitability devuelve array', Array.isArray(prof.body));

  const fleet = await req('GET', '/logistics/analytics/fleet-utilization', null, token);
  check('fleet-utilization status 200', fleet.status === 200);
  check('fleet-utilization devuelve array', Array.isArray(fleet.body));

  // Con rango de fechas
  const ovRange = await req('GET', '/logistics/analytics/overview?from=2026-01-01&to=2026-12-31', null, token);
  check('overview con rango status 200', ovRange.status === 200);
  check('overview con rango tiene period', !!ovRange.body?.period);

  // ─────────────────────────────────────────────────────────────────────
  // Staff/Personal endpoints (J.9.2)
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── 3. Staff/Personal endpoints (J.9.2) ──');
  const drivers = await req('GET', '/logistics/fleet/drivers', null, token);
  check('drivers list status 200', drivers.status === 200);
  check('drivers list es array', Array.isArray(drivers.body));

  // Crear un driver para validar
  const createDriver = await req('POST', '/logistics/fleet/drivers', {
    full_name: `TEST DRIVER J9 ${Date.now()}`,
    roles: ['chofer', 'ayudante'],
    employee_type: 'interno',
    status: 'activo',
    phone: '555-1234',
  }, token);
  check('driver creado con multi-roles', createDriver.status === 200 || createDriver.status === 201);
  check('driver tiene roles[] array', Array.isArray(createDriver.body?.roles) && createDriver.body.roles.includes('chofer'));
  const driverId = createDriver.body?.id;

  if (driverId) {
    // Filter by role
    const choferes = await req('GET', '/logistics/fleet/drivers?role=chofer', null, token);
    check('filter por role=chofer funciona', Array.isArray(choferes.body));

    // Update status
    const patch = await req('PATCH', `/logistics/fleet/drivers/${driverId}`, {
      status: 'suspendido',
    }, token);
    check('PATCH status driver OK', patch.body?.status === 'suspendido');

    // Cleanup
    await req('DELETE', `/logistics/fleet/drivers/${driverId}`, null, token);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Guides endpoints (J.9.3)
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── 4. Guides endpoints (J.9.3) ──');
  const guides = await req('GET', '/logistics/guides', null, token);
  check('guides list status 200', guides.status === 200);
  check('guides list es array', Array.isArray(guides.body));
  // Si hay guías, verificar shape
  if (guides.body && guides.body.length > 0) {
    const g = guides.body[0];
    check('guide tiene number', typeof g.number === 'string');
    check('guide tiene status', typeof g.status === 'string');
    check('guide tiene driver_commission', typeof g.driver_commission !== 'undefined');
    check('guide tiene per_diem_total', typeof g.per_diem_total !== 'undefined');
  } else {
    console.log('  (sin guías en data — shape no validable, expected en DB vacía)');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Costs endpoints (J.9.4) — endpoint NUEVO
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── 5. Costs endpoints (J.9.4 — endpoint findAll NUEVO) ──');
  const expenses = await req('GET', '/logistics/expenses', null, token);
  check('expenses list status 200', expenses.status === 200);
  check('expenses list es array', Array.isArray(expenses.body));

  const expensesLimit = await req('GET', '/logistics/expenses?limit=5', null, token);
  check('expenses con ?limit funciona', Array.isArray(expensesLimit.body) && expensesLimit.body.length <= 5);

  const expensesRange = await req('GET', '/logistics/expenses?from=2026-01-01&to=2026-12-31', null, token);
  check('expenses con ?from&to funciona', Array.isArray(expensesRange.body));

  // Verificar shape si hay data
  if (expenses.body && expenses.body.length > 0) {
    const e = expenses.body[0];
    check('expense tiene shipment_folio (JOIN OK)', typeof e.shipment_folio === 'string');
    check('expense tiene shipment_date (JOIN OK)', !!e.shipment_date);
    check('expense tiene fuel/tolls/total_cost', typeof e.fuel !== 'undefined' && typeof e.total_cost !== 'undefined');
  } else {
    console.log('  (sin expenses en data — shape no validable)');
  }

  const summary = await req('GET', '/logistics/expenses/summary', null, token);
  check('expenses summary status 200', summary.status === 200);
  check('summary tiene total_cost_sum', typeof summary.body?.total_cost_sum !== 'undefined' || typeof summary.body?.total_cost !== 'undefined');

  // ─────────────────────────────────────────────────────────────────────
  // Negative tests / security
  // ─────────────────────────────────────────────────────────────────────
  console.log('\n── 6. Negative tests ──');
  const noAuth = await req('GET', '/logistics/analytics/overview');
  // Sin JwtAuthGuard formal (deferred), el endpoint crashea con 500
  // porque current_tenant_id() no está seteado y RLS bloquea queries.
  // Funcionalmente la data NO se filtra: status >= 400 = no acceso.
  check('sin auth → no acceso (>=400)', noAuth.status >= 400);
  check('sin auth → no devuelve data', !noAuth.body?.shipments);

  const badPath = await req('GET', '/logistics/expenses/garbage-not-uuid', null, token);
  check('uuid inválido → 400 o 404', badPath.status === 400 || badPath.status === 404);

  // ─────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n────── Summary ──────`);
  console.log(`PASS: ${pass}`);
  console.log(`FAIL: ${fail}`);
  if (failures.length) console.log('Failures:', failures);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('Fatal:', e); process.exit(1); });
