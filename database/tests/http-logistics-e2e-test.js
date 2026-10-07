/* eslint-disable no-console */
/**
 * HTTP E2E test: módulos de logística completos.
 *
 * Cubre:
 *   1. Login auth-mt
 *   2. Config CRUD (lectura del seed baseline)
 *   3. Fleet — crear vehicle + driver + listarlos
 *   4. Shipments — create → depart → deliver → close (state machine completo)
 *   5. Guides — create + add recipient + mark delivered
 *   6. Expenses — upsert + recompute totals + summary
 *   7. Payroll — crear período + calculate liquidaciones
 *   8. Cleanup
 *
 * Requiere API corriendo en localhost:3334 con ENABLE_MULTITENANT=true y
 * seed baseline `06_mega_dulces_logistics_baseline.js` corrido.
 *
 * Correr: node database/http-logistics-e2e-test.js
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
  try { json = await r.json(); } catch (_) { /* no json */ }
  return { status: r.status, body: json };
}

function check(name, condition, detail) {
  if (condition) { console.log(`  OK   ${name}`); pass++; }
  else            { console.log(`  FAIL ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  // 1. Login
  console.log('── 1. Login ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces',
    username: 'superoot',
    password: 'superoot',
  });
  check('JWT recibido', login.body?.access_token);
  const token = login.body?.access_token;
  if (!token) {
    console.error('Sin token, abort');
    process.exit(1);
  }
  const perms = login.body?.user?.permissions || {};
  check('LOGISTICS_FLEET_VER en JWT', perms.LOGISTICS_FLEET_VER === true);
  check('LOGISTICS_SHIPMENTS_GESTIONAR en JWT', perms.LOGISTICS_SHIPMENTS_GESTIONAR === true);

  // 2. Config (lee seed baseline)
  console.log('\n── 2. Config ──');
  const cfg = await req('GET', '/logistics/config', null, token);
  check('GET config OK (status 200)', cfg.status === 200);
  const costoKm = (cfg.body || []).find((c) => c.key === 'costo_km_estandar');
  check('seed costo_km_estandar existe', costoKm && Number(costoKm.value) > 0, costoKm);

  // 3. Fleet — listar (debería tener DEMO-001 del seed) y crear uno nuevo
  console.log('\n── 3. Fleet ──');
  const vehicles = await req('GET', '/logistics/fleet/vehicles', null, token);
  check('GET vehicles 200', vehicles.status === 200);
  check('seed vehicle DEMO-001 presente', (vehicles.body || []).some((v) => v.plate === 'DEMO-001'));

  const plate = `TEST-${Date.now().toString().slice(-6)}`;
  const newVeh = await req('POST', '/logistics/fleet/vehicles', {
    plate,
    model: 'Modelo Test',
    capacity_boxes: 200,
    fuel_efficiency_km_l: 7.5,
    status: 'disponible',
  }, token);
  check('POST vehicle 201', newVeh.status === 201);
  check('vehicle.id presente', !!newVeh.body?.id);
  const vehicleId = newVeh.body?.id;

  const drivers = await req('GET', '/logistics/fleet/drivers', null, token);
  check('GET drivers 200', drivers.status === 200);
  const driverId = (drivers.body || []).find((d) => d.full_name === 'Chofer Demo')?.id;
  check('seed Chofer Demo presente', !!driverId);

  // 4. Shipments — full state machine
  console.log('\n── 4. Shipments state machine ──');
  const today = new Date().toISOString().slice(0, 10);
  const ship = await req('POST', '/logistics/shipments', {
    shipment_date: today,
    vehicle_id: vehicleId,
    origin: 'CEDIS',
    destination: 'Cliente X',
    type: 'entrega',
    cargo_value: 5000,
    boxes_count: 30,
    total_weight_kg: 250,
  }, token);
  check('POST shipment 201', ship.status === 201);
  check('folio EMB-* generado', /^EMB-\d{4}-\d{5}$/.test(ship.body?.folio), ship.body?.folio);
  check('status inicial = programado', ship.body?.status === 'programado');
  const shipmentId = ship.body?.id;

  // PATCH update km
  const patched = await req('PATCH', `/logistics/shipments/${shipmentId}`, { actual_km: 50, freight_revenue: 1500 }, token);
  check('PATCH shipment actual_km', patched.status === 200 && Number(patched.body?.actual_km) === 50);

  // depart
  const dep = await req('POST', `/logistics/shipments/${shipmentId}/depart`, {}, token);
  check('depart → en_ruta', dep.status === 201 && dep.body?.status === 'en_ruta');

  const v2 = await req('GET', `/logistics/fleet/vehicles/${vehicleId}`, null, token);
  check('vehicle quedó en_ruta', v2.body?.status === 'en_ruta');

  // intento ilegal: cerrar antes de entregar
  const badTrans = await req('POST', `/logistics/shipments/${shipmentId}/close`, {}, token);
  check('en_ruta → cerrado rechazado', badTrans.status === 409, badTrans.body);

  // deliver
  const del = await req('POST', `/logistics/shipments/${shipmentId}/deliver`, {}, token);
  check('deliver → entregado', del.status === 201 && del.body?.status === 'entregado');

  // close
  const closed = await req('POST', `/logistics/shipments/${shipmentId}/close`, {}, token);
  check('close → cerrado', closed.status === 201 && closed.body?.status === 'cerrado');

  const v3 = await req('GET', `/logistics/fleet/vehicles/${vehicleId}`, null, token);
  check('vehicle liberado a disponible', v3.body?.status === 'disponible');

  // 5. Guides + recipients
  console.log('\n── 5. Guides + recipients ──');
  // Creamos un shipment fresco (el anterior está cerrado, no admite guías)
  const ship2 = await req('POST', '/logistics/shipments', {
    shipment_date: today,
    vehicle_id: vehicleId,
    type: 'entrega',
  }, token);
  const shipment2Id = ship2.body?.id;
  check('shipment2 creado', !!shipment2Id);

  const guide = await req('POST', '/logistics/guides', {
    shipment_id: shipment2Id,
    driver_id: driverId,
    driver_commission: 150,
    auto_commissions: false,
  }, token);
  check('POST guide 201', guide.status === 201);
  check('folio GUIA-* generado', /^GUIA-\d{4}-\d{5}$/.test(guide.body?.number), guide.body?.number);
  const guideId = guide.body?.id;

  const recipient = await req('POST', `/logistics/guides/${guideId}/recipients`, {
    customer_name: 'Cliente E2E',
    boxes_count: 10,
    value: 1500,
  }, token);
  check('POST recipient 201', recipient.status === 201);
  const recipientId = recipient.body?.id;

  const delivered = await req('POST', `/logistics/guides/recipients/${recipientId}/deliver`, {
    delivered_to: 'Juan',
    gps_lat: 20.6,
    gps_lng: -103.4,
  }, token);
  check('mark recipient delivered', delivered.status === 201 && delivered.body?.status === 'entregado');

  const guideFull = await req('GET', `/logistics/guides/${guideId}`, null, token);
  check('GET guide con recipients', Array.isArray(guideFull.body?.recipients) && guideFull.body.recipients.length === 1);

  // 6. Expenses
  console.log('\n── 6. Expenses ──');
  // Reabrir un shipment editable: shipment2 sigue programado
  const exp = await req('PUT', `/logistics/expenses/shipments/${shipment2Id}`, {
    fuel: 800,
    tolls: 200,
    lodging: 0,
    handling: 100,
    apply_config_km: true,
  }, token);
  check('PUT expense 200', exp.status === 200);
  check('operating_subtotal calculado', Number(exp.body?.operating_subtotal) === 1100, exp.body);
  check('fixed_cost_per_km tomado de config', Number(exp.body?.fixed_cost_per_km) > 0);

  const expRead = await req('GET', `/logistics/expenses/shipments/${shipment2Id}`, null, token);
  check('GET expense OK', expRead.status === 200 && Number(expRead.body?.fuel) === 800);

  const summary = await req('GET', '/logistics/expenses/summary', null, token);
  check('GET summary OK', summary.status === 200 && summary.body?.total_cost_sum >= 1100);

  // 7. Payroll
  console.log('\n── 7. Payroll ──');
  // Crear período test. Backend valida number 1-27 (catorcenas año).
  // El importer J.8.2 ocupa slots 1-26 → usamos 27 que queda libre.
  const periodNum = 27;
  // start_date amplio (todo 2026) para capturar shipments del test creados hoy.
  // payment_date a 2027-01-15 (después de cualquier shipment de 2026).
  const periodBody = {
    number: periodNum,
    year: 2026,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    payment_date: '2027-01-15',
    notes: 'Test E2E (slot 27, rango anual para capturar shipments del test)',
  };
  const period = await req('POST', '/logistics/payroll/periods', periodBody, token);
  check('POST period 201/409', period.status === 201 || period.status === 409, period);
  const periodList = await req('GET', '/logistics/payroll/periods?year=2026', null, token);
  const periodId = periodList.body?.find((p) => p.number === periodNum)?.id;
  check('period id encontrado', !!periodId);
  // Si ya existía con dates viejas, PATCH para asegurar rango amplio
  if (periodId && period.status === 409) {
    await req('PATCH', `/logistics/payroll/periods/${periodId}`, {
      start_date: periodBody.start_date,
      end_date: periodBody.end_date,
      payment_date: periodBody.payment_date,
    }, token);
  }

  if (periodId) {
    const calc = await req('POST', `/logistics/payroll/periods/${periodId}/calculate`, {}, token);
    check('calculate 201', calc.status === 201);
    // Tolerante a state previo: el cálculo puede retornar 0 si ya fue procesado
    // en una corrida previa (idempotencia) o si las guides del test no califican.
    // Lo importante es que el endpoint responda con shape correcto.
    check('calculate retorna estructura válida', typeof (calc.body?.liquidations_processed) === 'number' && Array.isArray(calc.body?.results));

    const liqs = await req('GET', `/logistics/payroll/periods/${periodId}/liquidations`, null, token);
    check('GET liquidations 200', liqs.status === 200 && Array.isArray(liqs.body));
  }

  // 8. Cleanup — borrar shipment2 (programado), guía huérfana, vehicle test
  console.log('\n── 8. Cleanup ──');
  await req('POST', `/logistics/shipments/${shipment2Id}/cancel`, { reason: 'E2E cleanup' }, token);
  const del2 = await req('DELETE', `/logistics/shipments/${shipment2Id}`, null, token);
  check('DELETE shipment2 (post-cancel)', del2.status === 200);
  await req('POST', `/logistics/shipments/${shipmentId}/cancel`, { reason: 'E2E cleanup' }, token).catch(() => null);
  await req('DELETE', `/logistics/shipments/${shipmentId}`, null, token).catch(() => null);
  const delV = await req('DELETE', `/logistics/fleet/vehicles/${vehicleId}`, null, token);
  check('DELETE vehicle test', delV.status === 200);

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
