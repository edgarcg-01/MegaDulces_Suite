/* eslint-disable no-console */
/**
 * HTTP smoke E2E — Fase CBW (ADR-042): captura bancaria por WhatsApp, ida y vuelta
 * completo por el SIMULADOR (sin Meta). Prueba el flujo real contra el API vivo:
 *
 *   1. Login auth-mt (superoot).
 *   2. Alta de remitente autorizado (allowlist) con cuenta por defecto.
 *   3. Inyecta una IMAGEN por /webhooks/whatsapp/sim (media_data_uri) desde ese número.
 *   4. La captura aparece en la bandeja (GET /finance/bank-captures) en pendiente_confirmacion.
 *   5. Corrige atribución (PATCH monto+fecha) — la imagen sintética no trae OCR.
 *   6. Inyecta "sí" por el sim → confirma (status confirmado).
 *   7. Valida (POST /:id/validate) → MATERIALIZA el depósito en el libro (bank_movement_id).
 *   8. El renglón existe en /finance/bank/movements (M=I código 102).
 *   9. Un número NO autorizado + imagen → NO entra a la bandeja (ruteo por allowlist).
 *   10. Limpieza (borra movimiento/captura/statement/sender del test).
 *
 * Requiere: API en localhost:3334 con ENABLE_MULTITENANT=true y WHATSAPP_PROVIDER
 * ausente o 'simulator'. DB vía DATABASE_URL_NEW. Migraciones CBW aplicadas.
 *
 * Correr:  node database/tests/http-cbw-bank-capture-test.js
 */
const BASE = 'http://localhost:3334/api';
const TENANT_ID = process.env.WHATSAPP_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const STAMP = String(Date.now()).slice(-7);
const PHONE_META = '5211' + STAMP.padStart(9, '0').slice(-9); // como lo reporta Meta (521 + 10d)
const SENDER_NAME = 'Smoke Encargado ' + STAMP;
const WA_IMG = 'sim-cbw-img-' + Date.now();
// PNG 1x1 (sintético): la subida a Cloudinary funciona; el OCR no lee monto → corregimos a mano.
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let pass = 0, fail = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { console.log(`  OK  ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures.push(name); fail++; }
}
async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (e) { /* texto */ }
  return { status: r.status, body: json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, tries = 15, delay = 700) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(delay); }
  return null;
}
let db = null;
function getDb() {
  if (!db) { try { require('dotenv').config(); } catch (e) { /* opcional */ }
    db = require('knex')({ client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW } }); }
  return db;
}

(async () => {
  let token, senderId, accountId, captureId, movementId;
  try {
    console.log('── 1. Login auth-mt ──');
    const login = await req('POST', '/auth-mt/login', { username: 'superoot', password: 'superoot' });
    token = login.body?.access_token;
    check('login devuelve JWT', !!token, `status=${login.status}`);
    if (!token) throw new Error('sin token');

    console.log('── 2. Cuenta + alta de remitente (allowlist) ──');
    const accts = await req('GET', '/finance/bank/accounts', null, token);
    accountId = Array.isArray(accts.body) ? accts.body.find((a) => a.active)?.id : null;
    check('hay una cuenta de banco para el remitente', !!accountId, `status=${accts.status}`);

    const sender = await req('POST', '/finance/bank-captures/senders',
      { phone: PHONE_META, full_name: SENDER_NAME, sucursal: '30', default_bank_account_id: accountId }, token);
    senderId = sender.body?.id;
    check('alta de remitente autorizado', !!senderId, `status=${sender.status} body=${JSON.stringify(sender.body)}`);

    console.log('── 3. Inyecta IMAGEN por el simulador ──');
    const img = await req('POST', '/webhooks/whatsapp/sim',
      { from: PHONE_META, type: 'image', media_data_uri: TINY_PNG, wa_message_id: WA_IMG });
    check('sim acepta la imagen (accepted:1)', img.status === 200 && img.body?.accepted === 1, `body=${JSON.stringify(img.body)}`);

    console.log('── 4. La captura aparece en la bandeja ──');
    const cap = await poll(async () => {
      const r = await req('GET', `/finance/bank-captures?search=${encodeURIComponent(SENDER_NAME)}`, null, token);
      return (r.body?.rows || []).find((x) => x.sender_name === SENDER_NAME) || null;
    });
    captureId = cap?.id;
    check('captura en bandeja (procesada async)', !!captureId, 'no apareció tras el polling');
    check('captura en pendiente_confirmacion', cap?.status === 'pendiente_confirmacion', `status=${cap?.status}`);
    check('cuenta resuelta al default del remitente', !!cap?.cuenta, `cuenta=${cap?.cuenta}`);

    console.log('── 5. Corrige atribución (monto + fecha) ──');
    const today = new Date().toISOString().slice(0, 10);
    const patch = await req('PATCH', `/finance/bank-captures/${captureId}`, { amount_in: 1234.56, movement_date: today }, token);
    check('PATCH atribución OK', patch.status === 200 || patch.status === 201, `status=${patch.status}`);

    console.log('── 6. "sí" por el sim → confirma ──');
    await req('POST', '/webhooks/whatsapp/sim', { from: PHONE_META, type: 'text', text: 'sí', wa_message_id: 'sim-cbw-yes-' + Date.now() });
    const confirmed = await poll(async () => {
      const r = await req('GET', `/finance/bank-captures/${captureId}`, null, token);
      return r.body?.status === 'confirmado' ? r.body : null;
    });
    check('confirmación en chat → status confirmado', !!confirmed, `status=${confirmed?.status}`);

    console.log('── 7. Validar → materializa en el libro ──');
    const val = await req('POST', `/finance/bank-captures/${captureId}/validate`, {}, token);
    check('validate OK', val.status === 200 || val.status === 201, `status=${val.status} body=${JSON.stringify(val.body)}`);
    const detail = await req('GET', `/finance/bank-captures/${captureId}`, null, token);
    movementId = detail.body?.bank_movement_id;
    check('captura validada + ligada al movimiento', detail.body?.status === 'validado' && !!movementId, `status=${detail.body?.status} mov=${movementId}`);

    console.log('── 8. El renglón existe en el libro (Movimientos) ──');
    const period = today.slice(0, 7);
    const movs = await req('GET', `/finance/bank/movements?period=${period}&search=${encodeURIComponent(SENDER_NAME)}&limit=50`, null, token);
    const row = (movs.body?.rows || []).find((m) => m.id === movementId);
    check('depósito en el libro M=I / código 102', !!row && row.raw_type === 'I' && String(row.raw_code) === '102', `row=${JSON.stringify(row)}`);
    check('monto del renglón = corregido', row && Number(row.amount_in) === 1234.56, `amount_in=${row?.amount_in}`);

    console.log('── 9. Número NO autorizado + imagen → NO entra ──');
    const strangerPhone = '5219' + STAMP.padStart(9, '0').slice(-9);
    await req('POST', '/webhooks/whatsapp/sim', { from: strangerPhone, type: 'image', media_data_uri: TINY_PNG, wa_message_id: 'sim-cbw-stranger-' + Date.now() });
    await sleep(1500);
    const knex = getDb();
    const strangerCap = await knex('finance.bank_capture_inbox').where({ tenant_id: TENANT_ID, from_phone: '52' + strangerPhone.slice(-10) }).first('id');
    check('imagen de no-autorizado NO crea captura (ruteo por allowlist)', !strangerCap, `cap=${strangerCap?.id}`);

    console.log('── 10. Limpieza ──');
    if (movementId) {
      const mv = await knex('finance.bank_movements').where({ id: movementId }).first('statement_id', 'amount_in');
      await knex('finance.bank_movements').where({ id: movementId }).del();
      if (mv?.statement_id) {
        const left = await knex('finance.bank_movements').where({ statement_id: mv.statement_id }).count('* as n').first();
        if (Number(left.n) === 0) await knex('finance.bank_statements').where({ id: mv.statement_id }).del();
        else await knex('finance.bank_statements').where({ id: mv.statement_id }).update({ total_in: knex.raw('total_in - ?', [mv.amount_in]) });
      }
    }
    if (captureId) await knex('finance.bank_capture_inbox').where({ id: captureId }).del();
    if (senderId) await knex('finance.bank_capture_senders').where({ id: senderId }).del();
    console.log('  limpieza hecha (movimiento/statement/captura/remitente del test)');
    await knex.destroy();

    console.log(`\n${fail === 0 ? '✅' : '❌'} CBW HTTP E2E — ${pass} OK / ${fail} FAIL`);
    if (failures.length) console.log('   Fallas:', failures.join(', '));
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n❌ smoke abortó:', e.message);
    try { if (db) await db.destroy(); } catch (x) { /* nada */ }
    process.exit(1);
  }
})();
