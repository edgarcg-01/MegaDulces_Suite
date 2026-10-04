/* eslint-disable no-console */
/**
 * [PC.5]/[PC.6] — El BANCO de un pago a proveedor, tal como lo usan las cuatro coincidencias
 * (DB-direct, todo dentro de una transacción que se REVIERTE).
 *
 * Inserta en `kepler_ods` un banco (`kdb1`) y dos pagos `X-D-26` (`kdm1`): uno con `c45` apuntando a
 * ese banco y otro sin banco. Corre la MISMA consulta que el servicio (el LATERAL se lee del fuente
 * de `supplier-payment-proofs.service.ts`, no se copia) y comprueba:
 *   1. el pago con banco trae `clave_banco`, `banco_nombre` y el día como texto `YYYY-MM-DD`;
 *   2. ⛔ el pago SIN banco trae NULL (y por lo tanto nunca puede validarse solo);
 *   3. ⛔ el LATERAL no cruza doctypes: un `X-D-25` con el mismo folio no le presta su banco;
 *   4. las columnas de PC.6 existen en `finance.supplier_payment_proofs`.
 *
 * ⛔ NO corre contra producción (`assertSafeTarget`).
 */
const fs = require('fs');
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pc6-banco-del-pago');

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// La consulta del servicio, leída del fuente: si alguien la cambia, este test prueba la nueva.
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
  'supplier-payment-proofs', 'supplier-payment-proofs.service.ts'), 'utf8');
const m = /const LATERAL_BANCO_DEL_PAGO = `([\s\S]*?)`;/.exec(SRC);
const LATERAL = m ? m[1] : null;

const ROLLBACK = new Error('rollback');

(async () => {
  try {
    ok(!!LATERAL, 'el servicio declara LATERAL_BANCO_DEL_PAGO');
    if (!LATERAL) throw new Error('sin LATERAL');

    const hayOds = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
    if (!hayOds.rows[0].t) { console.log('  · NO MEDIDO: este entorno no tiene kepler_ods'); return; }

    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const CLAVE = '9463';
      await trx('kepler_ods.kdb1').insert({ sucursal: '00', c1: CLAVE, c2: 'BANCO PC6 9463', c3: '002496700783094636', c5: `102-${CLAVE}` });
      const base = { sucursal: '00', c1: '00', c2: 'X', c3: 'D', c5: 1, c10: 'C0101', c31: 'Tra', c32: 'CONVERMEX SA DE CV', c43: '' };
      await trx('kepler_ods.kdm1').insert([
        { ...base, c4: 26, c6: 'PC6T001', c9: '2026-09-29 00:00:00', c16: 150621.5, c45: CLAVE },
        { ...base, c4: 26, c6: 'PC6T002', c9: '2026-09-29 00:00:00', c16: 9000, c45: null },
        // mismo folio que PC6T002 pero cheque, CON banco: no debe prestárselo a la transferencia
        { ...base, c4: 25, c6: 'PC6T002', c9: '2026-09-29 00:00:00', c16: 9000, c31: 'Che', c45: CLAVE },
      ]);

      const q = (folio, docPrefix) => trx.raw(`
        SELECT c.monto::numeric AS monto, to_char(c.pago_date, 'YYYY-MM-DD') AS pago_dia, c.proveedor_nombre,
               kb.clave_banco, kb.banco_nombre, kb.account_label
          FROM analytics.erp_supplier_payments c
          ${LATERAL}
         WHERE c.tenant_id = ? AND c.sucursal = '00' AND c.doc_prefix = ? AND c.folio = ?`, [T, docPrefix, folio]).then((r) => r.rows[0]);

      const a = await q('PC6T001', 'XD2601');
      ok(!!a, 'el pago de prueba aparece en analytics.erp_supplier_payments');
      ok(a && a.clave_banco === CLAVE, `el pago trae su banco (clave_banco=${a && a.clave_banco})`);
      ok(a && a.banco_nombre === 'BANCO PC6 9463', `y su nombre (${a && a.banco_nombre})`);
      ok(a && a.pago_dia === '2026-09-29', `el día viene como texto YYYY-MM-DD (${a && a.pago_dia})`);
      ok(a && Number(a.monto) === 150621.5, `monto ${a && a.monto}`);

      const b = await q('PC6T002', 'XD2601');
      ok(!!b, 'el pago sin banco también aparece');
      ok(b && b.clave_banco == null, '⛔ el pago sin c45 trae clave_banco NULL (nunca se valida solo)');

      const ch = await q('PC6T002', 'XD2501');
      ok(ch && ch.clave_banco === CLAVE, 'el cheque con el mismo folio sí trae SU banco (el LATERAL distingue doctype)');

      const cols = await trx('information_schema.columns')
        .where({ table_schema: 'finance', table_name: 'supplier_payment_proofs' })
        .whereIn('column_name', ['coincidencias', 'auto_validado', 'lectura_verificada']).pluck('column_name');
      ok(cols.length === 3, `columnas PC.6 presentes (${cols.sort().join(',') || 'ninguna — falta la migración 20261004120000'})`);

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });
  } catch (e) {
    fail++;
    console.log('  ✗ error:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
