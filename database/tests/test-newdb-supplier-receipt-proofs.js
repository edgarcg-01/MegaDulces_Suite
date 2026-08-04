/* eslint-disable no-console */
/**
 * CC (extensión) — Smoke DB-directo de los comprobantes de PAGO A PROVEEDOR y de
 * ORDEN DE ENTRADA. Verifica contra la DB real:
 *   1. Schema: analytics.erp_supplier_payments + analytics.erp_goods_receipts
 *      (espejos, sin RLS) + finance.supplier_payment_proofs + finance.goods_receipt_proofs
 *      (RLS FORZADO).
 *   2. Datos del importer: pagos a proveedor multi-método (transferencia XD2601 +
 *      cheque XD2501, c10~C%): MONDELEZ 0016183 XD2601 = $914,850.29 (transferencia,
 *      el arquetipo) + GRUPO INDUSTRIAL SWEETS 0000609 XD2501 = $685,704.06 (cheque).
 *      doc_prefix en la PK desambigua el folio compartido entre doctypes. Entradas
 *      XA2001 "Aplica Orden Entrada" (GRUPO LEVI 0008231 = $827, línea VASO 94323).
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
    ok(Number(p.n) >= 3000, `erp_supplier_payments poblada (${p.n} pagos: transferencia XD2601 + cheque XD2501)`);
    // La PK debe incluir doc_prefix (folio NO es único entre XD2501/XD2601).
    const pk = await knex.raw(`SELECT string_agg(a.attname, ',' ORDER BY array_position(con.conkey, a.attnum)) cols
      FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace
      JOIN pg_attribute a ON a.attrelid=rel.oid AND a.attnum=ANY(con.conkey)
      WHERE con.contype='p' AND ns.nspname='analytics' AND rel.relname='erp_supplier_payments'`);
    ok(pk.rows[0].cols === 'tenant_id,sucursal,doc_prefix,folio', 'PK del espejo incluye doc_prefix');
    const methods = await knex('analytics.erp_supplier_payments').where({ tenant_id: T }).select('metodo_pago').count('* as n').groupBy('metodo_pago');
    const tra = methods.find((m) => m.metodo_pago === 'transferencia');
    const che = methods.find((m) => m.metodo_pago === 'cheque');
    const ant = methods.find((m) => m.metodo_pago === 'anticipo');
    ok(tra && Number(tra.n) > 1000, `pagos incluye transferencias XD2601 (${tra ? tra.n : 0})`);
    ok(che && Number(che.n) > 0, `pagos incluye cheques XD2501 (${che ? che.n : 0})`);
    ok(ant && Number(ant.n) > 0, `pagos incluye anticipos XD6001 (${ant ? ant.n : 0})`);
    // Anticipo real: el comprobante BBVA que reportó el usuario = CONVERMEX XD6001 $150,621.50.
    const anticipo = await knex('analytics.erp_supplier_payments').where({ tenant_id: T, sucursal: '00', doc_prefix: 'XD6001' })
      .whereRaw('monto::numeric BETWEEN 150621 AND 150622')
      .first('proveedor_nombre', 'metodo_pago');
    ok(anticipo && anticipo.metodo_pago === 'anticipo' && /CONVERMEX/i.test(anticipo.proveedor_nombre || ''), 'anticipo XD6001 CONVERMEX $150,621.50 presente (método anticipo)');
    // Arquetipo transferencia: MONDELEZ 0016183 XD2601 = $914,850.29 (= el caso del comprobante BBVA).
    const mond = await knex('analytics.erp_supplier_payments').where({ tenant_id: T, sucursal: '00', doc_prefix: 'XD2601', folio: '0016183' })
      .first('proveedor_nombre', 'metodo_pago', knex.raw('monto::numeric AS monto'));
    ok(mond && Math.abs(Number(mond.monto) - 914850.29) < 0.01, 'transferencia real 0016183 (XD2601) = $914,850.29');
    ok(mond && mond.metodo_pago === 'transferencia' && /MONDELEZ/i.test(mond.proveedor_nombre || ''), 'transferencia 0016183 = MONDELEZ (método transferencia)');
    // Cheque: GRUPO INDUSTRIAL SWEETS 0000609 XD2501 = $685,704.06.
    const pago = await knex('analytics.erp_supplier_payments').where({ tenant_id: T, sucursal: '00', doc_prefix: 'XD2501', folio: '0000609' })
      .first('proveedor_nombre', 'proveedor_rfc', 'pago_date', 'metodo_pago', 'doc_prefix', knex.raw('monto::numeric AS monto'));
    ok(pago && Math.abs(Number(pago.monto) - 685704.06) < 0.01, 'cheque real 0000609 (XD2501) = $685,704.06 presente');
    ok(pago && pago.metodo_pago === 'cheque' && /SWEETS/i.test(pago.proveedor_nombre || ''), 'pago 0000609 = GRUPO INDUSTRIAL SWEETS (método cheque)');
    ok(pago && pago.proveedor_rfc === 'GIS020419575', 'pago 0000609 con RFC del proveedor');
    // Existe algún folio en AMBOS doctypes → doc_prefix desambigua la PK (la lección).
    const sharedR = await knex.raw(`SELECT sucursal, folio FROM analytics.erp_supplier_payments
      WHERE tenant_id=? GROUP BY sucursal, folio HAVING count(*) = 2 LIMIT 1`, [T]);
    const SH = sharedR.rows[0];
    ok(!!SH, 'hay un folio compartido entre doctypes (cheque + transferencia) sin colisión de PK');

    const [g] = await knex('analytics.erp_goods_receipts').where({ tenant_id: T }).count('* as n');
    ok(Number(g.n) >= 8000, `erp_goods_receipts poblada (${g.n} entradas XA2001 "Aplica Orden Entrada")`);
    // Doc real verificado: GRUPO LEVI 0008231 (VASO #16 ANCHO 25 LEVI), total $827.
    const entrada = await knex('analytics.erp_goods_receipts').where({ tenant_id: T, sucursal: '00', folio: '0008231' })
      .first('proveedor_nombre', 'proveedor_rfc', 'vale_folio', 'doc_prefix', knex.raw('monto::numeric AS monto'));
    ok(entrada && Math.abs(Number(entrada.monto) - 827) < 0.01, 'entrada real 0008231 (GRUPO LEVI) = $827.00 (= total remisión)');
    ok(entrada && entrada.doc_prefix === 'XA2001', 'entrada 0008231 es doctype XA2001 (Aplica Orden Entrada)');
    ok(entrada && /GRUPO LEVI/i.test(entrada.proveedor_nombre || ''), 'entrada 0008231 = GRUPO LEVI');

    // Detalle por línea (auditoría renglón por renglón)
    const linreg = await knex.raw(`SELECT to_regclass('analytics.erp_goods_receipt_lines') l`);
    ok(!!linreg.rows[0].l, 'analytics.erp_goods_receipt_lines existe');
    const [ln] = await knex('analytics.erp_goods_receipt_lines').where({ tenant_id: T }).count('* as n');
    ok(Number(ln.n) > 8000, `erp_goods_receipt_lines poblada (${ln.n} líneas de detalle)`);
    const [le] = await knex('analytics.erp_goods_receipt_lines').where({ tenant_id: T, sucursal: '00', folio: '0008231' }).count('* as n');
    ok(Number(le.n) > 0, `entrada 0008231 tiene ${le.n} línea(s) de detalle para auditar`);
    const vaso = await knex('analytics.erp_goods_receipt_lines').where({ tenant_id: T, sucursal: '00', folio: '0008231', sku: '94323' })
      .first('nombre', knex.raw('importe::numeric AS importe'));
    ok(vaso && Math.abs(Number(vaso.importe) - 712.93) < 0.01, `línea SKU 94323 (VASO LEVI) importe $712.93 = calza con el PDF real`);

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
        tenant_id: T, sucursal: '00', folio: '0000609', doc_prefix: 'XD2501', metodo_pago: 'cheque',
        proveedor_nombre: pago.proveedor_nombre, proveedor_rfc: pago.proveedor_rfc,
        pago_date: pago.pago_date, pago_monto: monto,
        files: JSON.stringify([{ role: 'comprobante', url: 'http://x/y.pdf', public_id: 'x/y', kind: 'pdf' }]),
        ocr_monto: monto, ocr_banco: 'BBVA', ocr_referencia: 'SPEI-1', ocr_status: 'ok',
        monto_match: matchP(monto, monto), created_by: 'smoke',
      }).returning(['id', 'status']);
      ok(row.status === 'recibido', 'pago attach: nuevo comprobante → recibido');

      // El join incluye doc_prefix: el comprobante del cheque NO debe contar sobre la transferencia del mismo folio.
      const j = await trx.raw(`
        SELECT COALESCE(d.n,0)::int deposits, d.last_status, COALESCE(d.any_match,false) any_match
        FROM analytics.erp_supplier_payments c
        LEFT JOIN (SELECT sucursal, doc_prefix, folio, count(*) n,
                     (array_agg(status ORDER BY created_at DESC))[1] last_status, bool_or(monto_match) any_match
                   FROM finance.supplier_payment_proofs GROUP BY sucursal, doc_prefix, folio) d
          ON c.sucursal=d.sucursal AND c.doc_prefix=d.doc_prefix AND c.folio=d.folio
        WHERE c.tenant_id=? AND c.sucursal='00' AND c.doc_prefix='XD2501' AND c.folio='0000609'`, [T]);
      ok(Number(j.rows[0].deposits) === 1 && j.rows[0].any_match === true, 'pago join: 1 comprobante en el cheque + monto_match=true');
      // Aislamiento por doc_prefix: adjunto un comprobante al CHEQUE de un folio compartido
      // y verifico que NO aparece sobre la TRANSFERENCIA del mismo folio.
      await trx('finance.supplier_payment_proofs').insert({
        tenant_id: T, sucursal: SH.sucursal, folio: SH.folio, doc_prefix: 'XD2501', metodo_pago: 'cheque',
        files: JSON.stringify([{ role: 'comprobante', url: 'http://x/z.pdf' }]), ocr_status: 'manual', created_by: 'smoke',
      });
      const isoJoin = async (dp) => (await trx.raw(`
        SELECT COALESCE(d.n,0)::int deposits
        FROM analytics.erp_supplier_payments c
        LEFT JOIN (SELECT sucursal, doc_prefix, folio, count(*) n FROM finance.supplier_payment_proofs GROUP BY sucursal, doc_prefix, folio) d
          ON c.sucursal=d.sucursal AND c.doc_prefix=d.doc_prefix AND c.folio=d.folio
        WHERE c.tenant_id=? AND c.sucursal=? AND c.doc_prefix=? AND c.folio=?`, [T, SH.sucursal, dp, SH.folio])).rows[0].deposits;
      ok(Number(await isoJoin('XD2501')) === 1, 'aislamiento: el comprobante cuenta sobre el cheque (XD2501)');
      ok(Number(await isoJoin('XD2601')) === 0, 'aislamiento: NO se filtra a la transferencia (XD2601) del mismo folio');

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
        tenant_id: T, sucursal: '00', folio: '0008231',
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
        WHERE c.tenant_id=? AND c.sucursal='00' AND c.folio='0008231'`, [T]);
      ok(Number(j.rows[0].deposits) === 1 && j.rows[0].any_match === true, 'entrada join: 1 remisión + monto_match=true');

      const [v] = await trx('finance.goods_receipt_proofs').where({ id: row.id }).whereIn('status', ['recibido', 'rechazado'])
        .update({ status: 'validado' }).returning(['status']);
      ok(v.status === 'validado', 'entrada validar: recibido → validado');
      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    const [aP] = await knex('finance.supplier_payment_proofs').where({ sucursal: '00', folio: '0000609' }).count('* as n');
    const [aG] = await knex('finance.goods_receipt_proofs').where({ sucursal: '00', folio: '0008231' }).count('* as n');
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
