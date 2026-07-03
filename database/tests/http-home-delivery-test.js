/* eslint-disable no-console */
/**
 * HTTP smoke — Fase LM-K: entrega a domicilio desde folio Kepler.
 * Flujo: ingest ticket → ticket-lookup (+ allowlist) → dispatch-from-kepler →
 * my-deliveries → outcome (entrega + cobro COD) → rider-liquidation (arqueo).
 *
 * Requiere API en localhost:3334 con ENABLE_MULTITENANT=true y migraciones LM/LM-K
 * aplicadas. La siembra del ticket necesita STORE_INGEST_KEY (misma que el poller);
 * sin ella, se saltan los pasos que dependen del ticket (y se avisa).
 */

const BASE = 'http://localhost:3334/api';
const INGEST_KEY = process.env.STORE_INGEST_KEY || '';
let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

async function req(method, path, body, token, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* no json */ }
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); fail++; }
}
function skipStep(name, why) { console.log(`  SKIP ${name} — ${why}`); skip++; }

(async () => {
  console.log('── 1. Login superoot ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const token = login.body?.access_token;
  const userId = login.body?.user?.id || login.body?.user?.sub;
  check('login devuelve JWT + userId', !!token && !!userId, `user=${JSON.stringify(login.body?.user || {}).slice(0, 80)}`);
  if (!token) { console.log('sin token — abort'); process.exit(1); }

  console.log('\n── 2. Fixtures: moto + repartidor (ligado a superoot) ──');
  const suffix = Date.now().toString(36).toUpperCase().slice(-5);
  const veh = await req('POST', '/logistics/fleet/vehicles', {
    plate: `MOTO-${suffix}`, brand: 'Italika', model: 'FT150', capacity_boxes: 8, status: 'disponible',
  }, token);
  const vehicleId = veh.body?.id;
  check('crea moto (capacity_boxes=8)', !!vehicleId, `status=${veh.status}`);

  const drv = await req('POST', '/logistics/fleet/drivers', {
    full_name: `Repartidor Smoke ${suffix}`, roles: ['chofer'], employee_type: 'interno', user_id: userId,
  }, token);
  const driverId = drv.body?.id;
  check('crea repartidor ligado a superoot', !!driverId, `status=${drv.status}`);

  console.log('\n── 3. Allowlist ──');
  const denied = await req('GET', '/store/live/ticket-lookup?folio=999&warehouse=00', null, token);
  check('sucursal NO habilitada (00) rechazada', denied.status === 403 || denied.status === 400, `status=${denied.status}`);

  // ── Pasos que dependen del ticket sembrado ──
  const folio = `SMK${suffix}`;
  const serie = 'UD0199';
  if (!INGEST_KEY) {
    skipStep('ingest ticket + lookup + dispatch + outcome + arqueo', 'falta STORE_INGEST_KEY');
    return finish();
  }

  console.log('\n── 4. Ingest ticket Kepler (wh 01, CONTADO) ──');
  const ingest = await req('POST', '/store/live/ingest', {
    tickets: [{
      warehouse_code: '01', warehouse_name: 'Padre Hidalgo', serie, folio,
      ticket_ts: new Date().toISOString(), total: 250.5, forma_pago: 'CREDITO',
      items: [
        { sku: '100001', nombre: 'Paleta Payaso', cant: 3, importe: 90 },
        { sku: '100002', nombre: 'Bubaloo', cant: 5, importe: 160.5 },
      ],
    }],
    emit: false,
  }, token, { 'x-store-ingest-key': INGEST_KEY });
  check('ingest acepta ticket', ingest.status === 200 || ingest.status === 201, `status=${ingest.status}`);

  console.log('\n── 5. ticket-lookup ──');
  const look = await req('GET', `/store/live/ticket-lookup?folio=${folio}&serie=${serie}&warehouse=01`, null, token);
  check('lookup devuelve ticket', look.status === 200 && look.body?.folio === folio, `status=${look.status}`);
  check('lookup trae líneas (2)', (look.body?.items?.length || 0) === 2);
  check('CREDITO ⇒ collect sugerido true', look.body?.collect_on_delivery_suggested === true, `paid=${look.body?.already_paid}`);

  console.log('\n── 6. dispatch-from-kepler ──');
  const disp = await req('POST', '/commercial/home-delivery/dispatch-from-kepler', {
    folio, serie, warehouse_code: '01', driver_id: driverId, vehicle_id: vehicleId,
    shipment_date: new Date().toISOString().slice(0, 10),
    delivery_address: { recipient_name: 'Cliente Smoke', phone: '3510000000', street: 'Calle Falsa 123', references: 'Portón azul' },
    collect_on_delivery: true, amount_to_collect: 250.5,
  }, token);
  check('dispatch crea entrega (EMB+GUIA)', disp.status === 201 && !!disp.body?.recipient_id, `status=${disp.status} body=${JSON.stringify(disp.body).slice(0,120)}`);
  const recipientId = disp.body?.recipient_id;

  const disp2 = await req('POST', '/commercial/home-delivery/dispatch-from-kepler', {
    folio, serie, warehouse_code: '01', driver_id: driverId, vehicle_id: vehicleId,
    shipment_date: new Date().toISOString().slice(0, 10),
    delivery_address: { street: 'X' },
  }, token);
  check('anti doble-despacho por folio (409)', disp2.status === 409, `status=${disp2.status}`);

  console.log('\n── 7. my-deliveries (repartidor = superoot) ──');
  const mine = await req('GET', '/commercial/home-delivery/my-deliveries', null, token);
  const parada = (mine.body || []).find((d) => d.recipient_id === recipientId);
  check('my-deliveries incluye la parada', !!parada, `n=${(mine.body || []).length}`);
  check('parada trae items_snapshot (qué cargar)', (parada?.items_snapshot?.length || 0) === 2);
  check('parada marca cobro COD', parada?.collect_on_delivery === true && Number(parada?.amount_to_collect) === 250.5);

  console.log('\n── 8. outcome: entrega + cobro COD ──');
  const out = await req('POST', `/commercial/home-delivery/recipients/${recipientId}/outcome`, {
    outcome: 'delivered', whatsapp_confirmed: true, delivered_to: 'Cliente Smoke',
    payment: { method: 'cash', amount: 250.5, cash_received: 300 },
  }, token);
  check('outcome entregado + pago', out.status === 200 || out.status === 201, `status=${out.status} body=${JSON.stringify(out.body).slice(0,120)}`);
  check('pago registrado (change 49.5)', Number(out.body?.payment?.change_given) === 49.5, `payment=${JSON.stringify(out.body?.payment || {}).slice(0,120)}`);

  console.log('\n── 9. arqueo del repartidor ──');
  const business_date = new Date().toISOString().slice(0, 10);
  const open = await req('POST', '/commercial/rider-liquidations', { rider_user_id: userId, business_date, branch_store_id: null }, token);
  const liqId = open.body?.id;
  check('abre corte del día', !!liqId, `status=${open.status}`);
  const prev = await req('GET', `/commercial/rider-liquidations/${liqId}/preview`, null, token);
  check('preview: cash_expected incluye el cobro', Number(prev.body?.cash_expected) >= 250.5, `expected=${prev.body?.cash_expected}`);
  check('preview: deliveries_count >= 1', Number(prev.body?.deliveries_count) >= 1);
  const close = await req('POST', `/commercial/rider-liquidations/${liqId}/close`, {
    cash_breakdown: { '200': 1, '50': 1, '0.5': 1 }, // 250.5
  }, token);
  check('cierra corte', close.status === 200 || close.status === 201, `status=${close.status}`);
  check('cash_difference 0 (arqueo cuadra)', Number(close.body?.cash_difference) === 0, `diff=${close.body?.cash_difference}`);

  finish();
})();

function finish() {
  console.log(`\n── Resumen ── OK=${pass} FAIL=${fail} SKIP=${skip}`);
  if (failures.length) console.log('Fallas:', failures.join(', '));
  process.exit(fail > 0 ? 1 : 0);
}
