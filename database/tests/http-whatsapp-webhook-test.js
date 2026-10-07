/* eslint-disable no-console */
/**
 * HTTP smoke — Fase F.0/F.1: webhook conversacional de WhatsApp (simulador).
 *
 * Prueba el ida-y-vuelta SIN Meta (WHATSAPP_PROVIDER=simulator):
 *   1. GET  handshake de verificación (devuelve el challenge).
 *   2. POST /webhooks/whatsapp/sim con { from, text } → acepta 1 (crea hilo,
 *      loguea 'in', encola → placeholder responde → 'out').
 *   3. Reenvío del MISMO wa_message_id → dedup (accepted:0).
 *   4. DB: el hilo existe con estado abierto + hay mensajes 'in' y 'out'.
 *
 * Requiere API en localhost:3334 con ENABLE_MULTITENANT=true, WHATSAPP_PROVIDER
 * (ausente o 'simulator') y la migración whatsapp.conversation_threads aplicada.
 * El webhook es PÚBLICO (no login). La DB se lee vía DATABASE_URL_NEW.
 */

const BASE = 'http://localhost:3334/api';
const TENANT_ID = process.env.WHATSAPP_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const PHONE = '52133' + String(Date.now()).slice(-7); // número único por corrida
const WA_MSG_ID = 'sim-smoke-' + Date.now();
let pass = 0;
let fail = 0;
const failures = [];

let db = null;
function getDb() {
  if (!db) {
    try { require('dotenv').config(); } catch (e) { /* opcional */ }
    db = require('knex')({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW } });
  }
  return db;
}

async function req(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (e) { /* puede ser texto (verify) */ }
  let text = null;
  if (json == null) { try { text = await r.text(); } catch (e) { /* nada */ } }
  return { status: r.status, body: json, text };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  console.log('── 1. Handshake de verificación (GET) ──');
  const challenge = 'ch-' + Date.now();
  // En simulador el token no importa (devuelve el challenge). En Meta requeriría
  // WHATSAPP_VERIFY_TOKEN — el smoke corre en modo simulador.
  const verify = await req('GET', `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=whatever&hub.challenge=${challenge}`);
  const echoed = (verify.text || '').includes(challenge);
  check('GET verify devuelve el challenge', verify.status === 200 && echoed, `status=${verify.status} body=${verify.text}`);

  console.log('── 2. Mensaje entrante simulado (POST /sim) ──');
  const inbound = await req('POST', '/webhooks/whatsapp/sim', {
    from: PHONE, text: 'hola quiero hacer un pedido', wa_message_id: WA_MSG_ID, profile_name: 'Cliente Smoke',
  });
  check('POST /sim acepta 1 mensaje', inbound.status === 200 && inbound.body?.accepted === 1, `status=${inbound.status} body=${JSON.stringify(inbound.body)}`);

  console.log('── 3. Dedup: reenviar el mismo wa_message_id ──');
  const dup = await req('POST', '/webhooks/whatsapp/sim', {
    from: PHONE, text: 'hola quiero hacer un pedido', wa_message_id: WA_MSG_ID,
  });
  check('reenvío deduplicado (accepted:0)', dup.status === 200 && dup.body?.accepted === 0, `body=${JSON.stringify(dup.body)}`);

  // Dar un instante al worker (in-process es síncrono, pero la respuesta se
  // encola dentro del handler; en BullMQ hay un pequeño lag).
  await new Promise((r) => setTimeout(r, 400));

  console.log('── 4. DB: hilo + mensajes ──');
  try {
    const knex = getDb();
    const thread = await knex('whatsapp.conversation_threads')
      .where({ tenant_id: TENANT_ID, phone: PHONE })
      .first();
    check('hilo creado', !!thread, 'no se encontró el hilo por teléfono');
    check('hilo abierto (state != done)', thread && thread.state !== 'done', `state=${thread?.state}`);

    if (thread) {
      const msgs = await knex('whatsapp.messages')
        .where({ tenant_id: TENANT_ID, thread_id: thread.id })
        .select('direction');
      const ins = msgs.filter((m) => m.direction === 'in').length;
      const outs = msgs.filter((m) => m.direction === 'out').length;
      check('mensaje entrante registrado (1)', ins === 1, `in=${ins} (dedup no debe duplicar)`);
      check('respuesta placeholder registrada (>=1 out)', outs >= 1, `out=${outs}`);
    }
    await knex.destroy();
  } catch (e) {
    check('DB accesible (DATABASE_URL_NEW)', false, e.message);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} WhatsApp webhook smoke — ${pass} OK / ${fail} FAIL`);
  if (failures.length) console.log('   Fallas:', failures.join(', '));
  process.exit(fail === 0 ? 0 : 1);
})();
