/* eslint-disable no-console */
/**
 * [PGP.125] — El espejo de pagos a proveedor de los NUEVE servidores de Kepler
 * (DB-direct, todo dentro de una transacción que se REVIERTE).
 *
 * Inserta en `kepler_ods` el mismo folio en dos servidores, cada uno con su catálogo de cuentas (`kdb1`), y un
 * documento de 08 replicado en el ODS de 00. Comprueba:
 *   1. `analytics.erp_supplier_payments_servidores` trae el pago de 08 con la cuenta del catálogo de 08;
 *   2. ⛔ el mismo folio en 00 trae la cuenta del catálogo de 00 (la cuenta no se presta entre servidores);
 *   3. ⛔ un documento de 08 replicado en el ODS de 00 (`c1 ≠ sucursal`) NO aparece: cada pago, en su servidor;
 *   4. `analytics.erp_supplier_payments` sigue siendo SÓLO 00 (sus ~20 consumidores no cambian);
 *   5. Comprobantes de pago lee la de nueve servidores (leído del fuente del servicio, no copiado).
 *
 * ⛔ NO corre contra producción (`assertSafeTarget`).
 */
const fs = require('fs');
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp125-espejo-nueve-servidores');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const ROLLBACK = new Error('rollback');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
  'supplier-payment-proofs', 'supplier-payment-proofs.service.ts'), 'utf8');

(async () => {
  try {
    ok(SRC.includes("trx('analytics.erp_supplier_payments_servidores as c')"), 'Comprobantes de pago lee el espejo de nueve servidores');
    ok(!/trx\('analytics\.erp_supplier_payments( as c)?'\)/.test(SRC), '⛔ y ya no lee el de sólo CEDIS');

    const hay = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS ods, to_regclass('analytics.erp_supplier_payments_servidores') AS v`);
    if (!hay.rows[0].ods) { console.log('  · NO MEDIDO: este entorno no tiene kepler_ods'); return; }
    ok(!!hay.rows[0].v, 'existe analytics.erp_supplier_payments_servidores (migración 20261114130228)');
    if (!hay.rows[0].v) return;

    await knex.transaction(async (trx) => {
      const CLAVE = 'T125';
      await trx('kepler_ods.kdb1').insert([
        { sucursal: '00', c1: CLAVE, c2: 'BANCO 00 T125', c3: '002496700783094636', c5: `102-${CLAVE}` },
        { sucursal: '08', c1: CLAVE, c2: 'BANCO 08 T125', c3: '014496655039321695', c5: `102-${CLAVE}` },
      ]);
      const base = { c2: 'X', c3: 'D', c4: 26, c5: 1, c9: '2026-11-03 00:00:00', c10: 'CF006', c31: 'Tra', c32: 'FERRERO PRUEBA', c43: '', c45: CLAVE };
      await trx('kepler_ods.kdm1').insert([
        { ...base, sucursal: '08', c1: '08', c6: 'P125A', c16: 452754.08 },
        { ...base, sucursal: '00', c1: '00', c6: 'P125A', c16: 1000 },
        { ...base, sucursal: '00', c1: '08', c6: 'P125B', c16: 777 },
      ]);

      const nueve = (await trx.raw(`SELECT sucursal, folio, monto::numeric AS monto, cuenta_tesoreria, medio_pago, source_branch
          FROM analytics.erp_supplier_payments_servidores WHERE folio IN ('P125A', 'P125B') ORDER BY sucursal, folio`)).rows;
      const de08 = nueve.find((r) => r.sucursal === '08' && r.folio === 'P125A');
      const de00 = nueve.find((r) => r.sucursal === '00' && r.folio === 'P125A');
      ok(!!de08 && Number(de08.monto) === 452754.08, `el pago de 08 aparece con su importe (${de08 && de08.monto})`);
      ok(de08 && de08.cuenta_tesoreria === 'BANCO 08 T125' && de08.medio_pago === 'banco', `con la cuenta del catálogo de 08 (${de08 && de08.cuenta_tesoreria})`);
      ok(de08 && de08.source_branch === 'md_08', `y su origen md_08 (${de08 && de08.source_branch})`);
      ok(de00 && de00.cuenta_tesoreria === 'BANCO 00 T125', `⛔ el mismo folio en 00 trae la cuenta de 00, no la de 08 (${de00 && de00.cuenta_tesoreria})`);
      ok(!nueve.some((r) => r.folio === 'P125B'), '⛔ un documento de 08 replicado en el ODS de 00 no aparece');

      const cedis = (await trx.raw(`SELECT sucursal, folio FROM analytics.erp_supplier_payments WHERE folio IN ('P125A', 'P125B')`)).rows;
      ok(cedis.length === 1 && cedis[0].sucursal === '00', `analytics.erp_supplier_payments sigue siendo sólo 00 (${cedis.map((r) => r.sucursal + '/' + r.folio).join(',') || 'nada'})`);

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
