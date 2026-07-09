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
const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';
let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

// Fallback de siembra del ticket: si no hay STORE_INGEST_KEY (endpoint de ingest
// cerrado), insertamos directo en analytics.store_live_tickets vía DB.
let db = null;
function getDb() {
  if (!db) {
    try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }
    db = require('knex')({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW } });
  }
  return db;
}

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

  console.log('\n── 2. Fixtures: usuario REPARTIDOR (dominio Reparto, no flota) + moto opcional ──');
  const suffix = Date.now().toString(36).toUpperCase().slice(-5);
  // El repartidor es un USUARIO con rol `repartidor` (desacople Reparto↔Logística).
  // Se asegura vía DB (upsert idempotente) con hash bcrypt de un password conocido.
  const bcrypt = require('bcryptjs');
  const RIDER_USER = 'repartidor_smoke';
  const RIDER_PASS = 'repartidor_smoke';
  let riderUserId = null;
  try {
    const _db = getDb();
    const hash = await bcrypt.hash(RIDER_PASS, 10);
    const [row] = await _db('identity.users')
      .insert({
        tenant_id: MEGA_DULCES_TENANT_ID, username: RIDER_USER, password_hash: hash,
        nombre: 'Repartidor Smoke', role_name: 'repartidor', activo: true, warehouse_code: '01',
      })
      .onConflict(['tenant_id', 'username'])
      .merge(['password_hash', 'role_name', 'activo', 'warehouse_code', 'updated_at'])
      .returning('id');
    riderUserId = row.id;
    check('asegura usuario repartidor', !!riderUserId);
  } catch (e) { check('asegura usuario repartidor', false, e.message); return finish(); }

  // Login como el repartidor (para my-deliveries / outcome con SU identidad).
  const riderLogin = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: RIDER_USER, password: RIDER_PASS,
  });
  const riderToken = riderLogin.body?.access_token;
  check('login repartidor', !!riderToken, `status=${riderLogin.status}`);

  // Moto OPCIONAL (solo para overflow CEDIS). Ya no se crea un chofer de flota.
  const veh = await req('POST', '/logistics/fleet/vehicles', {
    plate: `MOTO-${suffix}`, brand: 'Italika', model: 'FT150', capacity_boxes: 8, status: 'disponible',
  }, token);
  const vehicleId = veh.body?.id;
  check('crea moto (capacity_boxes=8)', !!vehicleId, `status=${veh.status}`);

  // Reset de idempotencia: el corte es único por (rider_user_id, business_date).
  // Si una corrida previa de HOY ya lo cerró, borrarlo para que `open` cree uno
  // fresco (si no, `close` devuelve 409 "ya cerrado"). Solo data de smoke.
  try {
    const _db = getDb();
    const _today = new Date().toISOString().slice(0, 10);
    const liqIds = await _db('commercial.rider_liquidations')
      .where({ rider_user_id: riderUserId }).andWhere('business_date', '>=', _today).pluck('id');
    if (liqIds.length) {
      await _db('commercial.payments').whereIn('liquidation_id', liqIds).update({ liquidation_id: null });
      await _db('commercial.rider_liquidations').whereIn('id', liqIds).del();
    }
  } catch (e) { /* si falla el reset, el paso 9 lo reportará */ }

  console.log('\n── 3. Allowlist ──');
  const denied = await req('GET', '/store/live/ticket-lookup?folio=999&warehouse=00', null, token);
  check('sucursal NO habilitada (00) rechazada', denied.status === 403 || denied.status === 400, `status=${denied.status}`);

  // ── Ticket de prueba ──
  const folio = `SMK${suffix}`;
  const serie = 'UD0199';
  const items = [
    { sku: '100001', nombre: 'Paleta Payaso', cant: 3, importe: 90 },
    { sku: '100002', nombre: 'Bubaloo', cant: 5, importe: 160.5 },
  ];

  console.log('\n── 4. Sembrar ticket Kepler (wh 01) ──');
  if (INGEST_KEY) {
    const ingest = await req('POST', '/store/live/ingest', {
      tickets: [{ warehouse_code: '01', warehouse_name: 'Padre Hidalgo', serie, folio, ticket_ts: new Date().toISOString(), total: 250.5, forma_pago: 'CREDITO', items }],
      emit: false,
    }, token, { 'x-store-ingest-key': INGEST_KEY });
    check('ingest acepta ticket', ingest.status === 200 || ingest.status === 201, `status=${ingest.status}`);
  } else {
    try {
      await getDb()('analytics.store_live_tickets').insert({
        tenant_id: MEGA_DULCES_TENANT_ID, warehouse_code: '01', warehouse_name: 'Padre Hidalgo',
        serie, folio, ticket_ts: new Date().toISOString(), total: 250.5, forma_pago: 'CREDITO',
        items: JSON.stringify(items),
      }).onConflict(['tenant_id', 'warehouse_code', 'serie', 'folio']).ignore();
      check('ticket sembrado vía DB (sin STORE_INGEST_KEY)', true);
    } catch (e) { check('ticket sembrado vía DB', false, e.message); return finish(); }
  }

  console.log('\n── 5. ticket-lookup ──');
  const look = await req('GET', `/store/live/ticket-lookup?folio=${folio}&serie=${serie}&warehouse=01`, null, token);
  check('lookup devuelve ticket', look.status === 200 && look.body?.folio === folio, `status=${look.status}`);
  check('lookup trae líneas (2)', (look.body?.items?.length || 0) === 2);
  check('CREDITO ⇒ collect sugerido true', look.body?.collect_on_delivery_suggested === true, `paid=${look.body?.already_paid}`);

  console.log('\n── 6. dispatch-from-kepler (asigna a usuario repartidor) ──');
  const disp = await req('POST', '/commercial/home-delivery/dispatch-from-kepler', {
    folio, serie, warehouse_code: '01', rider_user_id: riderUserId, vehicle_id: vehicleId,
    shipment_date: new Date().toISOString().slice(0, 10),
    delivery_address: { recipient_name: 'Cliente Smoke', phone: '3510000000', street: 'Calle Falsa 123', references: 'Portón azul' },
    collect_on_delivery: true, amount_to_collect: 250.5,
  }, token);
  check('dispatch crea la parada', disp.status === 201 && !!disp.body?.recipient_id, `status=${disp.status} body=${JSON.stringify(disp.body).slice(0,120)}`);
  const recipientId = disp.body?.recipient_id;

  const disp2 = await req('POST', '/commercial/home-delivery/dispatch-from-kepler', {
    folio, serie, warehouse_code: '01', rider_user_id: riderUserId,
    shipment_date: new Date().toISOString().slice(0, 10),
    delivery_address: { street: 'X' },
  }, token);
  check('anti doble-despacho por folio (409)', disp2.status === 409, `status=${disp2.status}`);

  console.log('\n── 7. my-deliveries (autenticado como el repartidor) ──');
  const mine = await req('GET', '/commercial/home-delivery/my-deliveries', null, riderToken);
  const parada = (mine.body || []).find((d) => d.recipient_id === recipientId);
  check('my-deliveries incluye la parada', !!parada, `n=${(mine.body || []).length}`);
  check('parada trae items_snapshot (qué cargar)', (parada?.items_snapshot?.length || 0) === 2);
  check('parada marca cobro COD', parada?.collect_on_delivery === true && Number(parada?.amount_to_collect) === 250.5);

  console.log('\n── 8. outcome: firma obligatoria + monto bloqueado del ticket ──');
  const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  // Sin firma ⇒ backend rechaza (firma obligatoria, no a criterio del repartidor).
  const noSig = await req('POST', `/commercial/home-delivery/recipients/${recipientId}/outcome`, {
    outcome: 'delivered', payment: { method: 'cash', amount: 250.5, cash_received: 300 },
  }, riderToken);
  check('sin firma ⇒ 400 (firma obligatoria)', noSig.status === 400, `status=${noSig.status}`);

  // Con firma. Mando amount ERRÓNEO (1) a propósito: el backend debe IGNORARLO y
  // cobrar el monto fijo del ticket (250.5) → cambio 300−250.5 = 49.5.
  const out = await req('POST', `/commercial/home-delivery/recipients/${recipientId}/outcome`, {
    outcome: 'delivered', delivered_to: 'Cliente Smoke', signature_url: SIG,
    payment: { method: 'cash', amount: 1, cash_received: 300 },
  }, riderToken);
  check('outcome entregado + pago', out.status === 200 || out.status === 201, `status=${out.status} body=${JSON.stringify(out.body).slice(0,120)}`);
  check('monto BLOQUEADO del ticket (cobra 250.5, no 1)', Number(out.body?.payment?.amount) === 250.5, `amount=${out.body?.payment?.amount}`);
  check('cambio correcto sobre monto fijo (49.5)', Number(out.body?.payment?.change_given) === 49.5, `change=${out.body?.payment?.change_given}`);

  console.log('\n── 8b. tracking de tienda (dónde va el pedido) ──');
  const trk = await req('GET', '/commercial/home-delivery/dispatched?warehouse_code=01', null, token);
  const tRow = (trk.body || []).find((x) => x.delivery_id === recipientId);
  check('tracking lista la entrega', !!tRow, `n=${(trk.body || []).length}`);
  check('tracking muestra entregado + hora + repartidor', tRow?.status === 'entregado' && !!tRow?.delivered_at && !!tRow?.rider_user_id, `row=${JSON.stringify(tRow || {}).slice(0,120)}`);

  console.log('\n── 9. arqueo del repartidor ──');
  const business_date = new Date().toISOString().slice(0, 10);
  const open = await req('POST', '/commercial/rider-liquidations', { rider_user_id: riderUserId, business_date, branch_store_id: null }, token);
  const liqId = open.body?.id;
  check('abre corte del día', !!liqId, `status=${open.status}`);
  const prev = await req('GET', `/commercial/rider-liquidations/${liqId}/preview`, null, token);
  check('preview: cash_expected incluye el cobro', Number(prev.body?.cash_expected) >= 250.5, `expected=${prev.body?.cash_expected}`);
  check('preview: deliveries_count >= 1', Number(prev.body?.deliveries_count) >= 1);
  // Arqueo cuadra: el rider cuenta EXACTAMENTE lo esperado. cash_expected acumula
  // todos los cobros cash del día (múltiplos de 0.5) → breakdown en monedas de 0.5.
  const expected = Number(prev.body?.cash_expected) || 0;
  const close = await req('POST', `/commercial/rider-liquidations/${liqId}/close`, {
    cash_breakdown: { '0.5': Math.round(expected / 0.5) },
  }, token);
  check('cierra corte', close.status === 200 || close.status === 201, `status=${close.status}`);
  check('cash_difference 0 (arqueo cuadra)', Number(close.body?.cash_difference) === 0, `diff=${close.body?.cash_difference} expected=${expected}`);

  console.log('\n── 10. arqueo CIEGO del repartidor (LM.11) ──');
  // Fecha distinta (ayer) para no chocar con el corte del encargado de hoy.
  // El repartidor cierra SU corte a ciegas; sin pagos ese día ⇒ esperado 0.
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const blind = await req('POST', '/commercial/rider-liquidations/my/blind-close', {
    business_date: yday, cash_breakdown: {},
  }, riderToken);
  check('blind-close cierra (auto-scoped por JWT)', blind.status === 200 || blind.status === 201, `status=${blind.status} body=${JSON.stringify(blind.body).slice(0,120)}`);
  check('marca is_blind', blind.body?.is_blind === true, `is_blind=${blind.body?.is_blind}`);
  check('revela diferencia (esperado 0 ese día)', Number(blind.body?.cash_difference) === 0, `diff=${blind.body?.cash_difference}`);
  // Reset idempotencia del corte ciego de ayer (para re-correr).
  try {
    const _db = getDb();
    if (blind.body?.id) {
      await _db('commercial.payments').where({ liquidation_id: blind.body.id }).update({ liquidation_id: null });
      await _db('commercial.rider_liquidations').where({ id: blind.body.id }).del();
    }
  } catch (e) { /* noop */ }

  finish();
})();

async function finish() {
  if (db) { try { await db.destroy(); } catch (e) { /* noop */ } }
  console.log(`\n── Resumen ── OK=${pass} FAIL=${fail} SKIP=${skip}`);
  if (failures.length) console.log('Fallas:', failures.join(', '));
  process.exit(fail > 0 ? 1 : 0);
}
