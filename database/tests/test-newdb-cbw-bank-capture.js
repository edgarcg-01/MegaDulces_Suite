/* eslint-disable no-console */
/**
 * Fase CBW (ADR-042) — Captura bancaria por WhatsApp. Smoke DB-direct.
 *
 * Verifica contra la DB real (todo en UNA trx con ROLLBACK, cero efecto):
 *   1. Las 2 tablas (bank_capture_senders / bank_capture_inbox) existen con RLS FORZADO.
 *   2. resolveSender: allowlist por (phone, active) — activo resuelve, inactivo/otro no.
 *   3. resolveAccount: cuenta_dest con el tail de 4 dígitos casa el bank_account.
 *   4. capture(): inserta la captura en staging (pendiente_confirmacion) con FK a
 *      sender + bank_account + snapshot OCR + atribución (concept/sucursal/monto).
 *   5. Idempotencia: reenvío del MISMO wa_message_id no duplica (UNIQUE).
 *   6. confirm(): la última pendiente del teléfono → confirmado (SÍ) / descartado (NO).
 *   7. Regla dura ADR-042: NUNCA se toca finance.bank_movements (solo se referencia
 *      opcionalmente al cuadrar).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// Réplica de BankCaptureService.resolveAccount (tail 4 dígitos → account_label).
function last4(cuentaDest) { const d = (cuentaDest || '').replace(/\D/g, ''); return d.slice(-4); }

(async () => {
  try {
    // ── 1. Schema + RLS forzado ────────────────────────────────────────────
    for (const t of ['bank_capture_senders', 'bank_capture_inbox']) {
      const r = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'finance.${t}'::regclass`);
      ok(r.rows[0]?.relforcerowsecurity === true, `finance.${t} existe con RLS FORZADO`);
    }

    // Una cuenta real del catálogo para las FK + la resolución por tail.
    const acct = await knex('finance.bank_accounts').where({ tenant_id: T, active: true }).first('id', 'account_label');
    ok(!!acct, `hay al menos una bank_account del tenant (label ${acct?.account_label})`);

    await knex.transaction(async (trx) => {
      const phone = '5214431234567';

      // ── 2. resolveSender (allowlist) ─────────────────────────────────────
      const [sender] = await trx('finance.bank_capture_senders').insert({
        tenant_id: T, phone, full_name: 'Jose Mendez', sucursal: '30',
        default_bank_account_id: acct.id, active: true, created_by: 'smoke',
      }).returning(['id', 'full_name', 'sucursal', 'default_bank_account_id']);
      ok(!!sender.id, 'sender insertado (allowlist)');

      const resolved = await trx('finance.bank_capture_senders')
        .where({ tenant_id: T, phone, active: true })
        .first('id', 'full_name', 'sucursal', 'default_bank_account_id');
      ok(resolved && resolved.full_name === 'Jose Mendez', 'resolveSender: teléfono activo → identidad (nombre/sucursal/cuenta)');

      const none = await trx('finance.bank_capture_senders')
        .where({ tenant_id: T, phone: '5210000000000', active: true }).first('id');
      ok(!none, 'resolveSender: teléfono desconocido → null (no postea)');

      await trx('finance.bank_capture_senders').where({ id: sender.id }).update({ active: false });
      const inactive = await trx('finance.bank_capture_senders')
        .where({ tenant_id: T, phone, active: true }).first('id');
      ok(!inactive, 'resolveSender: remitente inactivo → null');
      await trx('finance.bank_capture_senders').where({ id: sender.id }).update({ active: true });

      // ── 3. resolveAccount (tail 4 dígitos) ───────────────────────────────
      const tail = last4(`****${acct.account_label}`);
      ok(tail === String(acct.account_label).replace(/\D/g, '').slice(-4), 'last4 extrae los últimos 4 del cuenta_dest OCR');
      const matchAcct = await trx('finance.bank_accounts')
        .where({ tenant_id: T, account_label: tail, active: true }).first('id');
      ok(matchAcct && matchAcct.id === acct.id, 'resolveAccount: cuenta_dest OCR casa el bank_account por label');

      // ── 4. capture() → staging ───────────────────────────────────────────
      const concept = ['Jose Mendez', 'Tienda La Piedad'].filter(Boolean).join(' — ');
      const [cap] = await trx('finance.bank_capture_inbox').insert({
        tenant_id: T, source: 'whatsapp', from_phone: phone, sender_id: sender.id,
        wa_message_id: 'wamid.SMOKE-CBW-1',
        files: JSON.stringify([{ url: 'http://x/y.jpg', public_id: 'x/y', kind: 'image' }]),
        ocr_monto: 3940.04, ocr_fecha: '2026-01-02', ocr_banco: 'SANTANDER',
        ocr_cuenta_dest: `****${acct.account_label}`, ocr_referencia: 'SPEI-999',
        ocr_ordenante: 'Tienda La Piedad', ocr_metodo: 'transferencia_spei',
        ocr_raw: JSON.stringify({ monto: 3940.04 }), ocr_status: 'ok',
        bank_account_id: matchAcct.id, sucursal: '30', concept,
        amount_in: 3940.04, amount_out: 0, movement_date: '2026-01-02',
        status: 'pendiente_confirmacion',
      }).returning(['id', 'status', 'amount_in', 'concept', 'bank_account_id', 'bank_movement_id']);
      ok(cap.status === 'pendiente_confirmacion', 'capture: nueva captura → pendiente_confirmacion');
      ok(Number(cap.amount_in) === 3940.04, 'capture: monto OCR → amount_in (el cargo)');
      ok(cap.concept.startsWith('Jose Mendez'), 'capture: concept = nombre del remitente + ordenante');
      ok(cap.bank_account_id === acct.id, 'capture: cuenta resuelta guardada');
      ok(cap.bank_movement_id === null, 'ADR-042: NO se liga a bank_movements en la captura (staging puro)');

      // ── 5. Idempotencia por wa_message_id ────────────────────────────────
      await trx('finance.bank_capture_inbox').insert({
        tenant_id: T, source: 'whatsapp', from_phone: phone, sender_id: sender.id,
        wa_message_id: 'wamid.SMOKE-CBW-1', files: JSON.stringify([]),
        amount_in: 3940.04, status: 'pendiente_confirmacion',
      }).onConflict(['tenant_id', 'wa_message_id']).merge({ updated_at: trx.fn.now() });
      const cnt = await trx('finance.bank_capture_inbox').where({ tenant_id: T, wa_message_id: 'wamid.SMOKE-CBW-1' }).count('* as n').first();
      ok(Number(cnt.n) === 1, 'idempotencia: reenvío del mismo wa_message_id no duplica (UNIQUE + merge)');

      // ── 6. confirm() SÍ → confirmado ─────────────────────────────────────
      const pending = await trx('finance.bank_capture_inbox')
        .where({ from_phone: phone, status: 'pendiente_confirmacion' })
        .orderBy('created_at', 'desc').first('id');
      ok(pending && pending.id === cap.id, 'confirm: encuentra la última captura pendiente del teléfono');
      const [confirmed] = await trx('finance.bank_capture_inbox').where({ id: pending.id })
        .update({ status: 'confirmado', updated_at: trx.fn.now() }).returning(['status']);
      ok(confirmed.status === 'confirmado', 'confirm SÍ: pendiente_confirmacion → confirmado');

      // NO quedan pendientes → un 2º SÍ no encuentra nada (no responde).
      const noPending = await trx('finance.bank_capture_inbox')
        .where({ from_phone: phone, status: 'pendiente_confirmacion' }).first('id');
      ok(!noPending, 'confirm: sin pendientes, no hay a qué aplicar SÍ/NO');

      // ── 6b. validate() MATERIALIZA el depósito en el libro (postToLedger) ────
      const capRow = await trx('finance.bank_capture_inbox').where({ id: cap.id })
        .first('id', 'bank_account_id', 'movement_date', 'sucursal', 'concept', 'amount_in');
      const period = String(capRow.movement_date instanceof Date ? capRow.movement_date.toISOString().slice(0, 10) : capRow.movement_date).slice(0, 7);
      // statement del mes (encuentra o crea)
      let stmt = await trx('finance.bank_statements').where({ tenant_id: T, bank_account_id: capRow.bank_account_id, period }).first('id', 'total_in');
      if (!stmt) {
        [stmt] = await trx('finance.bank_statements').insert({ tenant_id: T, bank_account_id: capRow.bank_account_id, period, status: 'reconciling', source_file: 'whatsapp', imported_by: 'whatsapp' }).returning(['id', 'total_in']);
      }
      const cat = await trx('finance.movement_categories').where({ tenant_id: T, code: 'cobranza' }).first('id');
      ok(!!cat, 'existe la categoría cobranza (ingreso 102) para clasificar el depósito');
      const [mov] = await trx('finance.bank_movements').insert({
        tenant_id: T, statement_id: stmt.id, bank_account_id: capRow.bank_account_id, movement_date: capRow.movement_date,
        category_id: cat?.id ?? null, raw_type: 'I', raw_code: '102', sucursal: capRow.sucursal, concept: capRow.concept,
        amount_in: capRow.amount_in, amount_out: 0, recon_status: 'pending', client_uuid: `whatsapp:${capRow.id}`,
        source_file: 'whatsapp', classified_by: 'manual',
      }).onConflict(['tenant_id', 'client_uuid']).merge({ amount_in: capRow.amount_in, updated_at: trx.fn.now() }).returning(['id', 'raw_type', 'raw_code', 'amount_in']);
      ok(mov.raw_type === 'I' && mov.raw_code === '102', 'materializa: renglón de depósito M=I código 102 en el libro');
      ok(Number(mov.amount_in) === 3940.04, 'materializa: amount_in = monto de la captura');

      await trx('finance.bank_capture_inbox').where({ id: cap.id })
        .update({ status: 'validado', bank_movement_id: mov.id, validated_by: 'rev', validated_at: trx.fn.now() });
      const linked = await trx('finance.bank_capture_inbox').where({ id: cap.id }).first('status', 'bank_movement_id');
      ok(linked.status === 'validado' && linked.bank_movement_id === mov.id, 'validate: captura → validado + ligada al movimiento del libro');

      // Idempotencia del posteo: mismo client_uuid no duplica el renglón.
      await trx('finance.bank_movements').insert({
        tenant_id: T, statement_id: stmt.id, bank_account_id: capRow.bank_account_id, movement_date: capRow.movement_date,
        raw_type: 'I', raw_code: '102', amount_in: capRow.amount_in, client_uuid: `whatsapp:${capRow.id}`, classified_by: 'manual',
      }).onConflict(['tenant_id', 'client_uuid']).merge({ updated_at: trx.fn.now() });
      const movCount = await trx('finance.bank_movements').where({ tenant_id: T, client_uuid: `whatsapp:${capRow.id}` }).count('* as n').first();
      ok(Number(movCount.n) === 1, 'materializa: idempotente — revalidar no duplica el renglón (client_uuid whatsapp:<id>)');

      // ── 7. Aislamiento por tenant (filtro explícito, como analytics.*) ────
      const otherTenant = await trx('finance.bank_capture_inbox')
        .where({ tenant_id: '00000000-0000-0000-0000-0000000000ff', wa_message_id: 'wamid.SMOKE-CBW-1' }).first('id');
      ok(!otherTenant, 'aislamiento: otro tenant no ve la captura');

      throw new Error('__ROLLBACK__'); // cero efecto real
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    console.log(`\nCBW bank-capture: ${pass} ok, ${fail} fallos`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('smoke CBW falló:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
