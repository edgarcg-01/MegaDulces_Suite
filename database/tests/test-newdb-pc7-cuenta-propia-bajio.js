/* eslint-disable no-console */
/**
 * [PC.7] — La corrección de `cuenta_propia` para comprobantes de BanBajío (DB-direct, ROLLBACK).
 *
 * Corre el UPDATE de la migración `20261004130000` (leído del archivo, no copiado) sobre filas de
 * prueba y comprueba:
 *   1. el SPEI real de BajioNet (`245765060201`, cuenta Kepler 6506 → etiqueta Bancos `506`) pasa
 *      de `cuenta_propia = false` a `true`;
 *   2. ⛔ una cuenta BanBajío que NO es nuestra (`245712340201`) sigue en `false`;
 *   3. ⛔ un número de 12 dígitos que termina en `506` pero de otro formato (sin cuenta Bajío que
 *      calce en el centro) no se toca;
 *   4. ⛔ `NULL` sigue `NULL`; 5. idempotente: la segunda corrida no cambia filas.
 *
 * ⛔ NO corre contra producción (`assertSafeTarget`).
 */
const fs = require('fs');
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pc7-cuenta-propia-bajio');

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const SRC = fs.readFileSync(path.join(__dirname, '..', 'migrations-newdb', '20261004130000_supplier_proof_cuenta_propia_bajio.js'), 'utf8');
const m = /trx\.raw\(`\s*(UPDATE finance\.supplier_payment_proofs[\s\S]*?)`\)/.exec(SRC);
const UPDATE = m ? m[1].replace(/\$\{MEGA\}/g, T) : null;
const ROLLBACK = new Error('rollback');

(async () => {
  try {
    ok(!!UPDATE, 'la migración declara el UPDATE');
    if (!UPDATE) throw new Error('sin UPDATE');
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      // Cuenta propia BanBajío como la sembró CB.0: etiqueta de 3 dígitos.
      await trx('finance.bank_accounts').insert({ tenant_id: T, bank: 'BBAJIO', account_label: '506', alias: 'BB 506 (pc7)', kind: 'bank' })
        .onConflict(['tenant_id', 'bank', 'account_label']).ignore();
      const base = { tenant_id: T, sucursal: '00', doc_prefix: 'XD2601', pago_monto: 9970.01, files: JSON.stringify([]), ocr_status: 'ok', created_by: 'pc7-smoke' };
      const ins = async (folio, cuenta, propia) => (await trx('finance.supplier_payment_proofs')
        .insert({ ...base, folio, ocr_cuenta_origen: cuenta, cuenta_propia: propia }).returning(['id']))[0].id;
      const real = await ins('PC7T001', '245765060201', false);   // SPEI real → cuenta 6506
      const ajena = await ins('PC7T002', '245712340201', false);  // Bajío, cuenta 1234: no es nuestra
      const otro = await ins('PC7T003', '999999990506', false);   // 12 díg., termina en 0506, centro 99999999
      const nulo = await ins('PC7T004', null, null);

      const r1 = await trx.raw(UPDATE);
      const get = async (id) => (await trx('finance.supplier_payment_proofs').where({ id }).first('cuenta_propia')).cuenta_propia;
      ok(await get(real) === true, 'el SPEI real de BajioNet (245765060201) queda como cuenta propia');
      ok(await get(ajena) === false, '⛔ otra cuenta BanBajío (2457 1234 0201) sigue como NO propia');
      ok(await get(otro) === false, '⛔ 12 dígitos que terminan en 506 pero sin la cuenta en el centro: no se toca');
      ok(await get(nulo) === null, '⛔ NULL sigue NULL');
      ok(r1.rowCount >= 1, `primera corrida corrige filas (${r1.rowCount})`);
      const r2 = await trx.raw(UPDATE);
      ok(r2.rowCount === 0, `idempotente: la segunda corrida no cambia nada (${r2.rowCount})`);
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
