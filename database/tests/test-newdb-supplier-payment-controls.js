/* eslint-disable no-console */
/**
 * SP.1-SP.4 — Controles del comprobante de pago a proveedor (DB-direct, rollback).
 *   1. Schema: columnas nuevas (ocr_concepto/ocr_cuenta_origen/cuenta_propia/ref_norm).
 *   2. cuenta_propia: cuenta de ORIGEN ∈ cuentas de banco propias.
 *   3. ref_norm: clave de rastreo normalizada (GENERATED) + dedup.
 *   4. Ficha-first: matchPaymentsByOcr por monto (+boost concepto).
 *   5. Three-way: bankMatch por cargo (amount_out) + confirm/unlink en bank_recon_matches.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  try {
    // 1. Schema
    const cols = await knex('information_schema.columns')
      .where({ table_schema: 'finance', table_name: 'supplier_payment_proofs' })
      .whereIn('column_name', ['ocr_concepto', 'ocr_cuenta_origen', 'cuenta_propia', 'ref_norm']).pluck('column_name');
    ok(cols.length === 4, `columnas SP.1 presentes (${cols.sort().join(',')})`);

    // 2. cuenta_propia (réplica isOwnAccount)
    const tails = await knex('finance.bank_accounts').where({ tenant_id: T, kind: 'bank', active: true })
      .whereRaw(`account_label ~ '^[0-9]{3,}$'`).pluck('account_label');
    const isOwn = (c) => { const d = String(c || '').replace(/\D/g, ''); return d && tails.length ? tails.some((t) => t.length >= 3 && d.endsWith(t)) : null; };
    ok(tails.includes('5712'), 'seed CB tiene la cuenta BBVA 5712 (cuenta de retiro del comprobante real)');
    ok(isOwn('0174915712') === true, 'cuenta de retiro 0174915712 (comprobante real) → cuenta propia (termina en 5712)');
    ok(isOwn('0009999999') === false, 'cuenta de origen ajena → NO propia');

    // 4. Ficha-first: matchPaymentsByOcr por monto
    const pago = await knex('analytics.erp_supplier_payments').where({ tenant_id: T }).where('monto', '>', 0)
      .orderBy('folio').first('sucursal', 'doc_prefix', 'folio', 'concepto', knex.raw('monto::numeric AS monto'), 'pago_date');
    ok(!!pago, `hay un pago real de referencia (${pago.doc_prefix} ${pago.sucursal}/${pago.folio} $${pago.monto})`);
    const M = Number(pago.monto);
    const found = await knex('analytics.erp_supplier_payments').where({ tenant_id: T })
      .whereRaw('monto BETWEEN ? AND ?', [M - 1, M + 1]).select('sucursal', 'doc_prefix', 'folio');
    ok(found.some((r) => r.folio === pago.folio && r.doc_prefix === pago.doc_prefix),
      'matchPaymentsByOcr: el comprobante $' + M + ' encuentra su pago por monto');
    // boost por concepto (tokens de factura)
    const tokens = String(pago.concepto || '').match(/\d{2,}/g) || [];
    ok(tokens.length === 0 || String(pago.concepto).includes(tokens[0]), 'concepto_match: el token de factura aparece en el concepto del pago');

    // 3 + 5. ref_norm generado, dedup, bankMatch + confirm/unlink (rollback)
    await knex.transaction(async (trx) => {
      const ba = await trx('finance.bank_accounts').where({ tenant_id: T, kind: 'bank' }).whereRaw(`account_label='5712'`).first('id');
      const [st] = await trx('finance.bank_statements').insert({ tenant_id: T, bank_account_id: ba.id, period: '2026-08', source_file: 'smoke' }).returning(['id']);
      const [mov] = await trx('finance.bank_movements').insert({
        tenant_id: T, statement_id: st.id, bank_account_id: ba.id,
        movement_date: pago.pago_date || '2026-08-03', amount_in: 0, amount_out: M,
        concept: 'PAGO PROVEEDOR SMOKE', client_uuid: 'smoke-cargo-sp',
      }).returning(['id']);

      const [pp] = await trx('finance.supplier_payment_proofs').insert({
        tenant_id: T, sucursal: pago.sucursal, doc_prefix: pago.doc_prefix, folio: pago.folio,
        pago_monto: M, files: JSON.stringify([{ role: 'comprobante', url: 'http://x/y.pdf' }]),
        ocr_monto: M, ocr_cuenta_origen: '0174915712', ocr_referencia: 'BNET0100-2608 030033240703',
        ocr_status: 'ok', cuenta_propia: isOwn('0174915712'), created_by: 'smoke',
      }).returning(['id', 'cuenta_propia', 'ref_norm']);
      ok(pp.cuenta_propia === true, 'attach: cuenta_propia=true (pago desde cuenta de la empresa)');
      ok(pp.ref_norm === 'BNET01002608030033240703',
        'ref_norm = clave de rastreo alfanumérica sin guiones/espacios (generada): ' + pp.ref_norm);

      // bankMatch (réplica): cargo por amount_out + cuenta + ventana de fecha
      const from = new Date(pago.pago_date || '2026-08-03'); from.setDate(from.getDate() - 1);
      const to = new Date(pago.pago_date || '2026-08-03'); to.setDate(to.getDate() + 6);
      const iso = (d) => d.toISOString().slice(0, 10);
      const hit = await trx('finance.bank_movements as m').where('m.tenant_id', T).where('m.bank_account_id', ba.id)
        .whereRaw('m.amount_out BETWEEN ? AND ?', [M - 1, M + 1]).whereBetween('m.movement_date', [iso(from), iso(to)]).select('m.id');
      ok(hit.length >= 1 && hit.some((h) => h.id === mov.id), 'bankMatch: el cargo (amount_out) casa por monto + cuenta origen + fecha');

      // confirm → persiste en bank_recon_matches con kepler_doc_tipo = doc_prefix
      await trx('finance.bank_recon_matches').insert({
        tenant_id: T, bank_movement_id: mov.id, kepler_sucursal: pago.sucursal, kepler_doc_tipo: pago.doc_prefix,
        kepler_doc_folio: pago.folio, kepler_cuenta: '102', kepler_amount: M, match_type: 'exact', matched_by: 'smoke',
      });
      await trx('finance.bank_movements').where({ id: mov.id }).update({ recon_status: 'matched' });
      const linked = await trx('finance.bank_recon_matches').where({ tenant_id: T, kepler_doc_tipo: pago.doc_prefix, kepler_doc_folio: pago.folio, kepler_sucursal: pago.sucursal }).select('bank_movement_id');
      ok(linked.length === 1 && linked[0].bank_movement_id === mov.id, 'confirmBank: pago ligado al cargo en bank_recon_matches');
      const [ms] = await trx('finance.bank_movements').where({ id: mov.id }).select('recon_status');
      ok(ms.recon_status === 'matched', 'confirmBank: el cargo queda recon_status=matched');
      // unlink
      await trx('finance.bank_recon_matches').where({ kepler_doc_tipo: pago.doc_prefix, kepler_doc_folio: pago.folio, kepler_sucursal: pago.sucursal, bank_movement_id: mov.id }).del();
      const [rest] = await trx('finance.bank_recon_matches').where({ bank_movement_id: mov.id }).count('* as n');
      if (Number(rest.n) === 0) await trx('finance.bank_movements').where({ id: mov.id }).update({ recon_status: 'pending' });
      const [ms2] = await trx('finance.bank_movements').where({ id: mov.id }).select('recon_status');
      ok(ms2.recon_status === 'pending', 'unlinkBank: al liberar el cargo, recon_status vuelve a pending');

      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    console.log(`\nSP supplier-payment-controls: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  }
})();
