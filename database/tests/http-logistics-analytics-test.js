/* eslint-disable no-console */
/**
 * HTTP smoke: logistics analytics endpoints (J.5).
 *
 * Cubre los 4 endpoints:
 *   1. /logistics/analytics/overview (con y sin rango)
 *   2. /logistics/analytics/shipment-profitability
 *   3. /logistics/analytics/fleet-utilization
 *   4. /logistics/analytics/payroll-totals
 *
 * Estrategia:
 *   - Crea un shipment realista (vehicle + expense + cierra) para tener data.
 *   - Llama los 4 endpoints y valida shape + valores derivados (margen, cost/km).
 *   - Cleanup del shipment al final.
 *
 * Requiere API en :3334 con ENABLE_MULTITENANT=true.
 */

const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  // Login
  console.log('── Login ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) { console.error('abort'); process.exit(1); }

  // Setup: crear shipment + expense + cerrar para tener data REALIZADA
  console.log('\n── Setup: shipment realizado ──');
  const vehicles = await req('GET', '/logistics/fleet/vehicles', null, token);
  const vehId = (vehicles.body || []).find((v) => v.plate === 'DEMO-001')?.id;
  check('vehicle DEMO-001 existe', !!vehId);

  const today = new Date().toISOString().slice(0, 10);
  const ship = await req('POST', '/logistics/shipments', {
    shipment_date: today,
    vehicle_id: vehId,
    origin: 'CEDIS',
    destination: 'Cliente Analytics Test',
    type: 'entrega',
    cargo_value: 8000,
    boxes_count: 50,
  }, token);
  const shipmentId = ship.body?.id;
  check('shipment creado', !!shipmentId, ship.body);

  await req('PATCH', `/logistics/shipments/${shipmentId}`, { actual_km: 80, freight_revenue: 2500 }, token);
  await req('POST', `/logistics/shipments/${shipmentId}/depart`, {}, token);
  await req('POST', `/logistics/shipments/${shipmentId}/deliver`, {}, token);
  await req('PUT', `/logistics/expenses/shipments/${shipmentId}`, {
    fuel: 600, tolls: 150, lodging: 0, parking: 50, handling: 200,
    apply_config_km: true,
  }, token);
  const closed = await req('POST', `/logistics/shipments/${shipmentId}/close`, {}, token);
  check('shipment cerrado', closed.body?.status === 'cerrado');

  // 1. Overview
  console.log('\n── 1. Overview ──');
  const ov = await req('GET', '/logistics/analytics/overview', null, token);
  check('GET overview 200', ov.status === 200);
  check('overview tiene shipments.count >= 1', ov.body?.shipments?.count >= 1, ov.body?.shipments);
  check('overview revenue.freight >= 2500', Number(ov.body?.revenue?.freight) >= 2500, ov.body?.revenue);
  check('overview cost.total > 0', Number(ov.body?.cost?.total) > 0, ov.body?.cost);
  check('overview margin.gross calculado', typeof ov.body?.margin?.gross === 'number', ov.body?.margin);
  check('overview cost.per_km > 0', Number(ov.body?.cost?.per_km) > 0, ov.body?.cost?.per_km);

  const ovRange = await req('GET', `/logistics/analytics/overview?from=${today}&to=${today}`, null, token);
  check('overview con rango 200', ovRange.status === 200);
  check('overview rango cuenta solo del día', ovRange.body?.shipments?.count >= 1, ovRange.body?.shipments);

  // 2. Shipment profitability — filtrar por DEMO-001 + rango hoy para que
  // el shipment recién creado aparezca aunque la base tenga muchos cerrados
  // con margen mayor (sin filtro caería fuera del top N por ranking).
  console.log('\n── 2. Shipment profitability ──');
  const prof = await req('GET', `/logistics/analytics/shipment-profitability?vehicle_id=${vehId}&from=${today}&to=${today}&limit=500`, null, token);
  check('GET profitability 200', prof.status === 200);
  check('profitability es array', Array.isArray(prof.body));
  const mine = (prof.body || []).find((p) => p.id === shipmentId);
  check('mi shipment está en profitability', !!mine, { folio: mine?.folio, count: prof.body?.length });
  check('mine revenue = 2500', Number(mine?.revenue) === 2500);
  check('mine margin = revenue - cost', mine && Number(mine.margin) === Number(mine.revenue) - Number(mine.cost));
  check('mine margin_pct calculado', typeof mine?.margin_pct === 'number');

  // 3. Fleet utilization
  console.log('\n── 3. Fleet utilization ──');
  const fleet = await req('GET', '/logistics/analytics/fleet-utilization', null, token);
  check('GET fleet 200', fleet.status === 200);
  check('fleet es array', Array.isArray(fleet.body));
  const demoVeh = (fleet.body || []).find((v) => v.plate === 'DEMO-001');
  check('vehicle DEMO-001 en utilization', !!demoVeh);
  check('DEMO-001 tiene shipments_realized >= 1', Number(demoVeh?.shipments_realized) >= 1, demoVeh);
  check('DEMO-001 tiene total_km >= 80', Number(demoVeh?.total_km) >= 80);

  // 4. Payroll totals
  console.log('\n── 4. Payroll totals ──');
  const pay = await req('GET', '/logistics/analytics/payroll-totals', null, token);
  check('GET payroll 200', pay.status === 200);
  check('payroll es array', Array.isArray(pay.body));
  // Si hay períodos seed, deberían aparecer. Si no, array vacío es válido.
  if ((pay.body || []).length > 0) {
    const first = pay.body[0];
    check('payroll item tiene period string', typeof first.period === 'string' && /\d{4}\/\d+/.test(first.period), first);
    check('payroll item tiene total_net numérico', typeof first.total_net === 'number');
  }

  const payYear = await req('GET', '/logistics/analytics/payroll-totals?year=2026', null, token);
  check('payroll filtrado por year 200', payYear.status === 200 && Array.isArray(payYear.body));

  // Cleanup
  console.log('\n── Cleanup ──');
  // Liberar shipment: ya está cerrado, hay que cancelar (no — cerrado no permite cancelar)
  // El cierre ya liberó el vehicle. Solo borramos el shipment (estaba cerrado, permite soft-delete).
  const del = await req('DELETE', `/logistics/shipments/${shipmentId}`, null, token);
  check('DELETE shipment test (post-close)', del.status === 200);

  console.log(`\n═══ Total: ${pass} pass / ${fail} fail ═══`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('💥 fatal:', err.message, err.stack);
  process.exit(1);
});
