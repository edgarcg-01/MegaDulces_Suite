/* eslint-disable no-console */
/**
 * HTTP smoke test — Fase E.1 (Remote Manager / Televenta).
 *
 * Pre-requisitos:
 *   - API en http://localhost:3334 con ENABLE_MULTITENANT=true.
 *   - Migración 20260527160000 aplicada.
 *   - Seed 02_mega_dulces_initial_roles aplicado (incluye tele_operator).
 *
 * Cobertura:
 *   1. Login auth-mt con superoot (tiene COMMERCIAL_TELEVENTA_*).
 *   2. GET /queue → lista priorizada con razones.
 *   3. POST /leads/:id/reserve → ReservationRecord.
 *   4. POST /leads/:id/reserve OTRA VEZ → 409 conflict.
 *   5. GET /my-reservations → 1 reserva activa.
 *   6. GET /customers/:id/snapshot → perfil + orders + calls + reservation.
 *   7. POST /calls (outcome=callback_scheduled sin next_action_at) → 400.
 *   8. POST /calls (outcome=no_sale, release_reservation=true) → 201.
 *   9. GET /my-reservations → 0 (reserva liberada).
 *  10. GET /customers/:id/calls → log creado.
 *  11. POST /calls (outcome=callback_scheduled + next_action_at).
 *  12. POST /reservations/:id/release con ID inexistente → 404.
 */

const BASE = 'http://localhost:3334/api';

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

let pass = 0, fail = 0;
function check(name, cond, det) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; }
}

(async () => {
  console.log('── 0. Login auth-mt ──');
  const login = await req('POST', '/auth-mt/login', null, {
    tenant_slug: 'mega_dulces',
    username: 'superoot',
    password: 'superoot',
  });
  const token = login.body?.access_token;
  check('login OK', login.status === 200 || login.status === 201);
  check('access_token presente', !!token, JSON.stringify(login.body).slice(0, 200));
  if (!token) { console.log('Abort: sin token'); process.exit(1); }

  console.log('\n── 1. GET /queue ──');
  const q = await req('GET', '/commercial/televenta/queue?limit=20', token);
  check('status 200', q.status === 200, `status=${q.status} body=${JSON.stringify(q.body).slice(0, 200)}`);
  check('items es array', Array.isArray(q.body));
  const items = Array.isArray(q.body) ? q.body : [];
  console.log(`    queue size: ${items.length}`);
  if (items.length > 0) {
    const sample = items[0];
    console.log(`    ej: ${sample.code} ${sample.name} reason=${sample.reason} last_order=${sample.last_order_at || 'never'}`);
    check('item tiene customer_id', typeof sample.customer_id === 'string');
    check('item tiene reason valida', ['inactive_critical', 'callback_due', 'inactive_normal', 'never_ordered', 'general'].includes(sample.reason));
    check('item tiene total_orders numérico', typeof sample.total_orders === 'number');
  } else {
    console.log('  (queue vacía — el tenant no tiene customers activos)');
  }

  if (items.length === 0) {
    console.log('\nAbort: sin customers en queue, no se puede continuar');
    console.log(`\n── ${pass} OK · ${fail} FAIL ──`);
    process.exit(fail > 0 ? 1 : 0);
  }

  const targetCustomer = items[0];

  console.log('\n── 2. POST /leads/:id/reserve ──');
  const reserveA = await req('POST', `/commercial/televenta/leads/${targetCustomer.customer_id}/reserve`, token);
  check('status 200', reserveA.status === 200, `status=${reserveA.status} body=${JSON.stringify(reserveA.body).slice(0, 200)}`);
  check('reservation id presente', !!reserveA.body?.id);
  check('expires_at futuro', reserveA.body && new Date(reserveA.body.expires_at).getTime() > Date.now());
  check('expires_in_seconds > 0', reserveA.body?.expires_in_seconds > 0);
  const reservationId = reserveA.body?.id;

  console.log('\n── 3. POST /leads/:id/reserve OTRA VEZ (debe ser 409) ──');
  const reserveB = await req('POST', `/commercial/televenta/leads/${targetCustomer.customer_id}/reserve`, token);
  check('status 409', reserveB.status === 409, `status=${reserveB.status}`);

  console.log('\n── 4. GET /my-reservations ──');
  const myRes = await req('GET', '/commercial/televenta/my-reservations', token);
  check('status 200', myRes.status === 200);
  check('al menos 1 reserva activa', Array.isArray(myRes.body) && myRes.body.length >= 1);
  check('reserva matchea', myRes.body?.some(r => r.id === reservationId));

  console.log('\n── 5. GET /customers/:id/snapshot ──');
  const snap = await req('GET', `/commercial/televenta/customers/${targetCustomer.customer_id}/snapshot`, token);
  check('status 200', snap.status === 200);
  check('customer presente', !!snap.body?.customer?.id);
  check('recent_orders array', Array.isArray(snap.body?.recent_orders));
  check('recent_calls array', Array.isArray(snap.body?.recent_calls));
  check('reservation matchea', snap.body?.reservation?.id === reservationId);
  console.log(`    customer: ${snap.body?.customer?.code} ${snap.body?.customer?.name}, orders=${snap.body?.recent_orders?.length}, calls=${snap.body?.recent_calls?.length}`);

  console.log('\n── 6. POST /calls (callback_scheduled sin next_action_at → 400) ──');
  const badCall = await req('POST', '/commercial/televenta/calls', token, {
    customer_id: targetCustomer.customer_id,
    outcome: 'callback_scheduled',
    notes: 'sin next_action_at',
  });
  check('status 400', badCall.status === 400, `status=${badCall.status}`);

  console.log('\n── 7. POST /calls (no_sale + release_reservation) ──');
  const okCall = await req('POST', '/commercial/televenta/calls', token, {
    customer_id: targetCustomer.customer_id,
    outcome: 'no_sale',
    notes: 'Smoke test E.1 — cliente no contesta',
    duration_minutes: 2,
    release_reservation: true,
  });
  check('status 201', okCall.status === 201, `status=${okCall.status} body=${JSON.stringify(okCall.body).slice(0,200)}`);
  check('call_log id presente', !!okCall.body?.id);

  console.log('\n── 8. GET /my-reservations después de release ──');
  const myResAfter = await req('GET', '/commercial/televenta/my-reservations', token);
  check('status 200', myResAfter.status === 200);
  check('reserva no aparece', !myResAfter.body?.some(r => r.id === reservationId));

  console.log('\n── 9. GET /customers/:id/calls ──');
  const calls = await req('GET', `/commercial/televenta/customers/${targetCustomer.customer_id}/calls`, token);
  check('status 200', calls.status === 200);
  check('al menos 1 call_log', Array.isArray(calls.body) && calls.body.length >= 1);
  const latestCall = calls.body?.[0];
  check('outcome = no_sale', latestCall?.outcome === 'no_sale');
  check('notes preservadas', latestCall?.notes?.includes('Smoke test E.1'));
  check('operator_username presente', !!latestCall?.operator_username);

  console.log('\n── 10. POST /calls (callback con next_action_at) ──');
  // Re-reserve para volver a poder loguear
  await req('POST', `/commercial/televenta/leads/${targetCustomer.customer_id}/reserve`, token);
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const cbCall = await req('POST', '/commercial/televenta/calls', token, {
    customer_id: targetCustomer.customer_id,
    outcome: 'callback_scheduled',
    notes: 'Cliente pidió llamar mañana',
    next_action_at: tomorrow,
    release_reservation: true,
  });
  check('status 201', cbCall.status === 201);

  console.log('\n── 11. POST /reservations/:fakeId/release (404) ──');
  const fakeRelease = await req('POST', '/commercial/televenta/reservations/00000000-0000-0000-0000-000000000000/release', token);
  check('status 404', fakeRelease.status === 404);

  console.log(`\n── ${pass} OK · ${fail} FAIL ──`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
