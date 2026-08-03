/* eslint-disable no-console */
/**
 * CC (extensión) — Smoke DB-directo de los comprobantes de PAGO A PROVEEDOR y de
 * ORDEN DE ENTRADA. Verifica contra la DB real:
 *   1. Schema: analytics.erp_supplier_payments + analytics.erp_goods_receipts
 *      (espejos, sin RLS) + finance.supplier_payment_proofs + finance.goods_receipt_proofs
 *      (RLS FORZADO).
 *   2. Datos del importer: pagos XD2501 (incluye GRUPO INDUSTRIAL SWEETS 0000609 =
 *      $685,704.06) + entradas X-A-40 (incluye 0008353 = $111,986.88).
 *   3. Lógica monto_match (réplica del servicio): pagos tolerancia $1; entradas
 *      cuadran por total O subtotal.
 *   4. Flujo attach → join → validar → rechazar → CHECK dentro de trx con ROLLBACK.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const TOL = 1.0;
// Réplica del SupplierPaymentProofsService: |ocr - pago| <= 1 → cuadra.
const matchP = (ocr, pago) => (ocr == null ? null : Math.abs(ocr - pago) <= TOL);
// Réplica del GoodsReceiptProofsService: total O subtotal ≈ valor → cuadra.
const matchR = (total, sub, val) => {
  const near = (v) => v != null && Math.abs(v - val) <= TOL;
  return (total == null && sub == null) ? null : (near(total) || near(sub));
};

(async () => {
  try {
    // ── 1. Schema ────────────────────────────────────────────────────────────
    const reg = await knex.raw(`SELECT
      to_regclass('analytics.erp_supplier_payments') sp, to_regclass('finance.supplier_payment_proofs') spp,
      to_regclass('analytics.erp_goods_receipts') gr, to_regclass('finance.goods_receipt_proofs') grp`);
    ok(!!reg.rows[0].sp, 'analytics.erp_supplier_payments existe');
    ok(!!reg.rows[0].spp, 'finance.supplier_payment_proofs existe');
    ok(!!reg.rows[0].gr, 'analytics.erp_goods_receipts existe');
    ok(!!reg.rows[0].grp, 'finance.goods_receipt_proofs existe');
    const rls = await knex.raw(`SELECT
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='finance.supplier_payment_proofs'::regclass) spp,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='finance.goods_receipt_proofs'::regclass) grp`);
    ok(rls.rows[0].spp === true, 'supplier_payment_proofs con RLS FORZADO');
    ok(rls.rows[0].grp === true, 'goods_receipt_proofs con RLS FORZADO');

    // ── 2. Datos del importer ────────────────────────────────────────────────
    const [p] = await knex('analytics.erp_supplier_payments').where({ tenant_id: T }).count('* as n');
    ok(Number(p.n) >= 600, `erp_supplier_payments poblada (${p.n} pagos XD2501)`);
    const pago = await knex('analytics.erp_supplier_payments').where({ tenant_id: T, sucursal: '00', folio: '0000609' })
      .first('proveedor_nombre', 'proveedor_rfc', 'pago_date', knex.raw('monto::numeric AS monto'));
    ok(pago && Math.abs(Number(pago.monto) - 685704.06) < 0.01, 'pago real 0000609 = $685,704.06 presente');
    ok(pago && /SWEETS/i.test(pago.proveedor_nombre || ''), 'pago 0000609 = GRUPO INDUSTRIAL SWEETS');
    ok(pago && pago.proveedor_rfc === 'GIS020419575', 'pago 0000609 con RFC del proveedor');

    const [g] = await knex('analytics.erp_goods_receipts').where({ tenant_id: T }).count('* as n');
    ok(Number(g.n) >= 8000, `erp_goods_receipts poblada (${g.n} entradas X-A-40)`);
    const entrada = await knex('analytics.erp_goods_receipts').where({ tenant_id: T, sucursal: '00', folio: '0008353' })
      .first('proveedor_nombre', 'proveedor_rfc', 'vale_folio', knex.raw('monto::numeric AS monto'));
    ok(entrada && Math.abs(Number(entrada.monto) - 111986.88) < 0.01, 'entrada real 0008353 = $111,986.88 presente');
    ok(entrada && entrada.vale_folio === '0008471', 'entrada 0008353 enlaza al vale 0008471 (X-A-37)');
    ok(entrada && entrada.proveedor_rfc === 'PCP920523HQA', 'entrada 0008353 con RFC del proveedor (vía vale)');

    // ── 3. Lógica de cuadre ──────────────────────────────────────────────────
    ok(matchP(685704.06, 685704.06) === true, 'pago: match exacto → cuadra');
    ok(matchP(685704.56, 685704.06) === true, 'pago: diferencia $0.50 → cuadra');
    ok(matchP(685000.00, 685704.06) === false, 'pago: diferencia $704 → NO cuadra');
    ok(matchP(null, 685704.06) === null, 'pago: sin monto OCR → null');
    ok(matchR(111986.88, null, 111986.88) === true, 'entrada: total cuadra');
    ok(matchR(130000, 111986.88, 111986.88) === true, 'entrada: subtotal cuadra aunque total no');
    ok(matchR(130000, null, 111986.88) === false, 'entrada: total lejano y sin subtotal → NO cuadra');

    // ── 4a. Flujo PAGO (rollback) ────────────────────────────────────────────
    await knex.transaction(async (trx) => {
      const monto = Number(pago.monto);
      const [row] = await trx('finance.supplier_payment_proofs').insert({
        tenant_id: T, sucursal: '00', folio: '0000609',
        proveedor_nombre: pago.proveedor_nombre, proveedor_rfc: pago.proveedor_rfc,
        pago_date: pago.pago_date, pago_monto: monto,
        files: JSON.stringify([{ role: 'comprobante', url: 'http://x/y.pdf', public_id: 'x/y', kind: 'pdf' }]),
        ocr_monto: monto, ocr_banco: 'BBVA', ocr_referencia: 'SPEI-1', ocr_status: 'ok',
        monto_match: matchP(monto, monto), created_by: 'smoke',
      }).returning(['id', 'status']);
      ok(row.status === 'recibido', 'pago attach: nuevo comprobante → recibido');

      const j = await trx.raw(`
        SELECT COALESCE(d.n,0)::int deposits, d.last_status, COALESCE(d.any_match,false) any_match
        FROM analytics.erp_supplier_payments c
        LEFT JOIN (SELECT sucursal, folio, count(*) n,
                     (array_agg(status ORDER BY created_at DESC))[1] last_status, bool_or(monto_match) any_match
                   FROM finance.supplier_payment_proofs GROUP BY sucursal, folio) d
          ON c.sucursal=d.sucursal AND c.folio=d.folio
        WHERE c.tenant_id=? AND c.sucursal='00' AND c.folio='0000609'`, [T]);
      ok(Number(j.rows[0].deposits) === 1 && j.rows[0].any_match === true, 'pago join: 1 comprobante + monto_match=true');

      const [v] = await trx('finance.supplier_payment_proofs').where({ id: row.id }).whereIn('status', ['recibido', 'rechazado'])
        .update({ status: 'validado' }).returning(['status']);
      ok(v.status === 'validado', 'pago validar: recibido → validado');
      const [rj] = await trx('finance.supplier_payment_proofs').where({ id: row.id }).whereIn('status', ['recibido', 'validado'])
        .update({ status: 'rechazado', motivo_rechazo: 'x' }).returning(['status']);
      ok(rj.status === 'rechazado', 'pago rechazar: validado → rechazado');
      let bad = false;
      try { await trx('finance.supplier_payment_proofs').insert({ tenant_id: T, sucursal: '00', folio: 'Z', status: 'foo' }); }
      catch (e) { bad = e.code === '23514'; }
      ok(bad, 'pago CHECK rechaza status inválido');
      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    // ── 4b. Flujo ENTRADA (rollback) ─────────────────────────────────────────
    await knex.transaction(async (trx) => {
      const val = Number(entrada.monto);
      const [row] = await trx('finance.goods_receipt_proofs').insert({
        tenant_id: T, sucursal: '00', folio: '0008353',
        proveedor_nombre: entrada.proveedor_nombre, proveedor_rfc: entrada.proveedor_rfc,
        receipt_monto: val,
        files: JSON.stringify([{ role: 'remision', url: 'http://x/r.jpg', public_id: 'x/r', kind: 'image' }]),
        ocr_folio: 'REM-42', ocr_proveedor: entrada.proveedor_nombre, ocr_rfc: entrada.proveedor_rfc,
        ocr_subtotal: val, ocr_iva: 0, ocr_monto: val, ocr_status: 'ok',
        monto_match: matchR(val, val, val), created_by: 'smoke',
      }).returning(['id', 'status']);
      ok(row.status === 'recibido', 'entrada attach: nueva remisión → recibido');

      const j = await trx.raw(`
        SELECT COALESCE(d.n,0)::int deposits, d.last_status, COALESCE(d.any_match,false) any_match
        FROM analytics.erp_goods_receipts c
        LEFT JOIN (SELECT sucursal, folio, count(*) n,
                     (array_agg(status ORDER BY created_at DESC))[1] last_status, bool_or(monto_match) any_match
                   FROM finance.goods_receipt_proofs GROUP BY sucursal, folio) d
          ON c.sucursal=d.sucursal AND c.folio=d.folio
        WHERE c.tenant_id=? AND c.sucursal='00' AND c.folio='0008353'`, [T]);
      ok(Number(j.rows[0].deposits) === 1 && j.rows[0].any_match === true, 'entrada join: 1 remisión + monto_match=true');

      const [v] = await trx('finance.goods_receipt_proofs').where({ id: row.id }).whereIn('status', ['recibido', 'rechazado'])
        .update({ status: 'validado' }).returning(['status']);
      ok(v.status === 'validado', 'entrada validar: recibido → validado');
      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    const [aP] = await knex('finance.supplier_payment_proofs').where({ sucursal: '00', folio: '0000609' }).count('* as n');
    const [aG] = await knex('finance.goods_receipt_proofs').where({ sucursal: '00', folio: '0008353' }).count('* as n');
    ok(Number(aP.n) === 0 && Number(aG.n) === 0, 'rollback: 0 evidencias persistidas (no ensucia data real)');

    console.log(`\nCC supplier+receipt proofs: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  }
})();
