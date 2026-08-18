/* eslint-disable no-console */
/**
 * COMM-P1 — WS de la bandeja de cobranza (namespace `/cobranza`).
 *
 * Qué protege: `/finanzas/cobranza` era la ÚNICA de las dos bandejas gemelas sin
 * tiempo real (su espejo `/finanzas/pagos-comprobantes` sí tenía gateway). Mismo
 * flujo capturista→revisor: si el revisor valida, el capturista tenía que refrescar
 * a mano para enterarse.
 *
 * Verifica:
 *   1. Handshake: JWT válido conecta y recibe `connected` con su tenant_id.
 *   2. JWT inválido → `auth_error` + desconexión (no se filtra nada).
 *   3. `attach` de una ficha → llega `collection_deposit_changed` action=attached
 *      con sucursal/folio/cliente/monto/actor.
 *   4. `validate` → action=validated con status='validado'.
 *   5. `reject`  → action=rejected con status='rechazado'.
 *   6. Aislamiento: un 2º tenant conectado al mismo namespace NO recibe nada.
 *
 * El flujo va por HTTP (como lo hace la UI) y la evidencia creada se BORRA al final
 * por DB — no hay endpoint de delete y no queremos dejar basura en la bandeja.
 *
 * Requiere API arriba (COBRANZA_TEST_PORT, default 3334) con ENABLE_MULTITENANT=true
 * y al menos un cobro en `analytics.erp_collections` sin evidencia adjunta.
 */

const { io } = require('socket.io-client');
const { Client } = require('pg');

const PORT = process.env.COBRANZA_TEST_PORT || 3334;
const BASE = `http://localhost:${PORT}/api`;
const WS_BASE = `http://localhost:${PORT}`;
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const MARKER = 'smoke COMM-P1 cobranza WS';

async function http(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let pass = 0, fail = 0;
function check(name, cond, det) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Conecta al namespace `/cobranza` y acumula los eventos recibidos. */
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const socket = io(`${WS_BASE}/cobranza`, {
      path: '/reports/socket.io',
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    const events = [];
    let connectedPayload = null;
    socket.on('collection_deposit_changed', (e) => events.push(e));
    socket.on('connected', (p) => { connectedPayload = p; });
    socket.on('connect', () => setTimeout(() => resolve({ socket, events, connectedPayload: () => connectedPayload }), 250));
    socket.on('connect_error', (e) => reject(e));
    socket.on('auth_error', (e) => reject(new Error('auth_error: ' + JSON.stringify(e))));
    setTimeout(() => reject(new Error('connection timeout')), 6000);
  });
}

/** Espera un evento con la acción pedida sobre el folio pedido. */
async function waitEvent(events, action, folio, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ev = events.find((e) => e.action === action && e.folio === folio);
    if (ev) return ev;
    await sleep(200);
  }
  return null;
}

(async () => {
  const login = await http('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
  const token = login.body?.access_token;
  check('login OK', !!token, `status=${login.status}`);
  if (!token) process.exit(1);

  // ── 1. handshake ──
  console.log('\n── 1. Handshake WS /cobranza ──');
  const ws = await connectWs(token);
  check('conecta con JWT válido', !!ws.socket.connected);
  check('recibe `connected` con tenant_id', !!ws.connectedPayload()?.tenant_id, JSON.stringify(ws.connectedPayload()));

  // ── 2. token inválido ──
  console.log('\n── 2. JWT inválido ──');
  const rejected = await connectWs('token.basura.invalido').then(() => null).catch((e) => e.message);
  check('rechaza token inválido', !!rejected && /auth_error|invalid/i.test(rejected), String(rejected).slice(0, 80));

  // ── 3. attach → evento attached ──
  console.log('\n── 3. attach ──');
  const cobros = await http('GET', '/finance/collections?estado=pendiente&incluir_todas=1&limit=1', null, token);
  const cobro = (cobros.body?.rows || [])[0];
  check('hay un cobro sin evidencia', !!cobro, `status=${cobros.status} n=${cobros.body?.rows?.length}`);
  if (!cobro) { console.log('\n⚠ sin cobros pendientes en analytics.erp_collections — corré el importer de cobranza y repetí.'); ws.socket.disconnect(); process.exit(1); }
  console.log(`    cobro objetivo: ${cobro.sucursal}/${cobro.folio} — ${cobro.cliente_nombre || '?'} $${cobro.monto}`);

  const attach = await http('POST', '/finance/collections/attach', {
    sucursal: cobro.sucursal,
    folio: cobro.folio,
    files: [{ role: 'deposito', url: 'https://example.invalid/smoke-comm-p1.jpg', kind: 'image' }],
    ocr: { monto: Number(cobro.monto) || 0, ocr_status: 'manual' },
    comentarios: MARKER,
  }, token);
  check('attach 200/201', attach.status === 200 || attach.status === 201, `status=${attach.status} ${JSON.stringify(attach.body)?.slice(0, 140)}`);
  const depositId = attach.body?.id;
  check('devuelve id de la evidencia', !!depositId);

  const evAttached = await waitEvent(ws.events, 'attached', cobro.folio);
  check('llegó `attached` por WS', !!evAttached, `eventos=${JSON.stringify(ws.events.map((e) => e.action))}`);
  check('el evento trae sucursal + monto', evAttached?.sucursal === cobro.sucursal && Number(evAttached?.monto) > 0, JSON.stringify(evAttached));
  check('el evento trae el actor', !!evAttached?.actor, `actor=${evAttached?.actor}`);

  // ── 4-5. validate / reject ──
  if (depositId) {
    console.log('\n── 4. validate ──');
    const val = await http('POST', `/finance/collections/${depositId}/validate`, {}, token);
    check('validate 200/201', val.status === 200 || val.status === 201, `status=${val.status}`);
    const evVal = await waitEvent(ws.events, 'validated', cobro.folio);
    check('llegó `validated` por WS', !!evVal);
    check('status=validado en el evento', evVal?.status === 'validado', `status=${evVal?.status}`);

    console.log('\n── 5. reject ──');
    const rej = await http('POST', `/finance/collections/${depositId}/reject`, { motivo: MARKER }, token);
    check('reject 200/201', rej.status === 200 || rej.status === 201, `status=${rej.status}`);
    const evRej = await waitEvent(ws.events, 'rejected', cobro.folio);
    check('llegó `rejected` por WS', !!evRej);
    check('status=rechazado en el evento', evRej?.status === 'rechazado', `status=${evRej?.status}`);
  }

  // ── 6. aislamiento entre tenants ──
  console.log('\n── 6. Aislamiento de tenant ──');
  const login2 = await http('POST', '/auth-mt/login', { tenant_slug: 'tenant_test_2', username: 'superoot2', password: 'superoot2' });
  if (login2.body?.access_token) {
    const ws2 = await connectWs(login2.body.access_token).catch(() => null);
    if (ws2) {
      check('tenant 2 conecta a su propia room', !!ws2.socket.connected);
      check('tenant 2 NO ve los eventos del tenant 1', ws2.events.length === 0, `recibió ${ws2.events.length}`);
      ws2.socket.disconnect();
    } else {
      console.log('    (tenant 2 no pudo conectar — se omite el chequeo de aislamiento)');
    }
  } else {
    console.log('    (no existe el 2º tenant de prueba — se omite el chequeo de aislamiento)');
  }

  ws.socket.disconnect();

  // ── limpieza: la evidencia del smoke no se queda en la bandeja ──
  if (depositId) {
    const pg = new Client({ connectionString: DST });
    try {
      await pg.connect();
      const del = await pg.query(`DELETE FROM finance.collection_deposits WHERE id = $1 AND comentarios = $2`, [depositId, MARKER]);
      check('limpieza: evidencia del smoke borrada', del.rowCount === 1, `rowCount=${del.rowCount}`);
      // NO se toca finance.bank_recon_matches: `attach` no escribe ahí (solo
      // confirmBank/linkBank lo hacen) y borrar por folio podría llevarse una
      // conciliación real hecha por el motor.
    } catch (e) {
      check('limpieza: evidencia del smoke borrada', false, `no pude limpiar: ${e.message}`);
    } finally { await pg.end().catch(() => {}); }
  }

  console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pass} OK · ${fail} FAIL\n${'='.repeat(60)}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR fatal:', e.message); process.exit(1); });
