/* eslint-disable no-console */
/**
 * `[LE.1.14]` `[LE.2.8]` — Las órdenes con código, contra Postgres real.
 *
 * Mide la migración `20261102134515_le114_cashbook_ordenes_con_codigo`:
 *  · PARIDAD: `cashbook._codigo(seq)` da exactamente lo mismo que `armarCodigo(seq)` del .ts real
 *    (cargado con ts-node): el código que imprime la pantalla es el que el carril reconoce.
 *  · el saldo de la orden: se consume en partes, nunca de más; completa queda `usada`;
 *  · un código vigente no se repite y un documento de Kepler se paga UNA vez;
 *  · `app_runtime` sólo lee: escribir la tabla a mano es 42501 (D10);
 *  · MUTACIÓN: sin el candado del saldo, el «de más» sí pasaría.
 * Todo en transacciones que se deshacen.
 */
const path = require('path');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..');
require(path.join(REPO, 'node_modules', 'ts-node')).register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const { armarCodigo } = require(path.join(REPO, 'libs/finance/src/lib/cashbook/codigo-formato.ts'));
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cashbook-ordenes');

const uuid = () => crypto.randomUUID();
const T = uuid();
const U1 = uuid();
let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };
async function intento(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try { await fn(); } catch (e) { err = { code: e.code, constraint: e.constraint, message: String(e.message) }; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return err;
}
const dijo = (e) => (e ? `${e.code} ${e.constraint || ''}` : 'pasó sin error');
const orden = (over = {}) => ({ actor: { kind: 'persona', user_id: U1 }, kind: 'custodia', amount_minor: '1000000',
  classification: { tipo: 'custodia', empleado: 'e-1', nombre: 'Compras' }, expires_at: new Date(Date.now() + 3600e3).toISOString(), ...over });
const emitir = async (trx, p) => (await trx.raw('SELECT cashbook.issue_order(?::jsonb) AS r', [JSON.stringify(p)])).rows[0].r;
const consumir = async (trx, code, minor, at = new Date()) =>
  (await trx.raw('SELECT cashbook.consume_order(?, ?, ?) AS r', [code, minor, at.toISOString()])).rows[0].r;

(async () => {
  try {
    console.log('\n── 0. La migración está aplicada ──');
    const { rows: [h] } = await knex.raw(`SELECT to_regclass('cashbook.withdrawal_orders') IS NOT NULL AS t, to_regprocedure('cashbook._codigo(bigint)') IS NOT NULL AS f`);
    if (!h.t || !h.f) { ok(false, 'la migración 20261102134515 NO está aplicada en esta base: nada se puede medir'); return; }
    ok(true, 'la tabla de órdenes y sus funciones existen');

    console.log('\n── 1. PARIDAD: el código del .ts y el de la base son el mismo ──');
    const { rows } = await knex.raw(`SELECT s, cashbook._codigo(s) AS c FROM generate_series(0, 2999) s`);
    const distintos = rows.filter((r) => r.c !== armarCodigo(Number(r.s)));
    ok(distintos.length === 0, `3,000 consecutivos: ${distintos.length} distintos (${distintos.slice(0, 3).map((r) => r.s).join(', ')})`);

    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;
    await knex.transaction(async (trx) => {
      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      else skip('sin app_runtime: corre como superusuario.');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      console.log('\n── 2. Emitir y consumir ──');
      const o = await emitir(trx, orden());
      ok(/^[A-HJ-NP-Z2-9]{4}-\d$/.test(o.code) && o.code === armarCodigo(Number(o.seq)), `la orden nace con su código ${o.code}`);
      const r1 = await consumir(trx, o.code, 600000);
      ok(r1.ok === true && Number(r1.remaining_minor) === 400000, 'se consume en partes: quedan $4,000');
      const r2 = await consumir(trx, o.code, 500000);
      ok(r2.ok === false && r2.motivo === 'de_mas', `[negativa] sacar más de lo que queda → de_mas (dio ${JSON.stringify(r2)})`);
      const r3 = await consumir(trx, o.code.toLowerCase(), 400000);
      ok(r3.ok === true && Number(r3.remaining_minor) === 0, 'el resto, aunque se tecleó en minúsculas');
      const estado = (await trx.raw(`SELECT state FROM cashbook.withdrawal_orders WHERE code = ?`, [o.code])).rows[0].state;
      ok(estado === 'usada', `completa queda «usada» (${estado})`);
      const r4 = await consumir(trx, o.code, 100);
      ok(r4.ok === false && r4.motivo === 'desconocido', '[negativa] un código ya usado ya no autoriza nada');
      const r5 = await consumir(trx, 'ZZZZ-1', 100);
      ok(r5.ok === false && r5.motivo === 'desconocido', '[negativa] un código que no existe → desconocido');

      console.log('\n── 3. Vencido, documento una vez, sin plazo ──');
      const v = await emitir(trx, orden());
      const r6 = await consumir(trx, v.code, 100, new Date(Date.now() + 7200e3));
      ok(r6.ok === false && r6.motivo === 'vencido', '[negativa] después de su vigencia → vencido');
      const DOC = '00|X-D-26|0023782|0011';
      const pago = orden({ kind: 'pago', source_ref: DOC, classification: { tipo: 'pago', concepto: 'NOMINA CEDIS', documento: DOC } });
      await emitir(trx, pago);
      const e1 = await intento(trx, () => emitir(trx, pago));
      ok(!!e1 && e1.code === '23505', `[negativa] el mismo X-D-26 no se ordena dos veces → 23505 (${dijo(e1)})`);
      const e2 = await intento(trx, () => emitir(trx, orden({ kind: 'pago', source_ref: null, classification: { tipo: 'pago', concepto: 'X', documento: 'Y' } })));
      ok(!!e2 && ['cashbook_orden_pago_con_documento', 'cashbook_orden_pago_clasificada'].includes(e2.constraint), `[negativa] un pago sin su documento → ${dijo(e2)}`);
      // `[LE.2.9]` Una orden de pago se asienta como el gasto de SU documento, nunca como cajón.
      const e2b = await intento(trx, () => emitir(trx, orden({ kind: 'pago', source_ref: '00|X-D-26|0023799|0011', classification: { tipo: 'cajon' } })));
      ok(!!e2b && e2b.constraint === 'cashbook_orden_pago_clasificada', `[negativa] una orden de pago clasificada como cajón → ${dijo(e2b)}`);
      const e2c = await intento(trx, () => emitir(trx, orden({ kind: 'pago', source_ref: '00|X-D-26|0023799|0011', classification: { tipo: 'pago', concepto: 'X', documento: '00|X-D-26|0000001|0011' } })));
      ok(!!e2c && e2c.constraint === 'cashbook_orden_pago_clasificada', `[negativa] una orden de pago que apunta a OTRO documento → ${dijo(e2c)}`);
      const e2d = await intento(trx, () => emitir(trx, orden({ classification: { tipo: 'pago', concepto: '', documento: 'Y' } })));
      ok(!!e2d && ['cashbook_orden_clasificacion', 'cashbook_orden_pago_clasificada'].includes(e2d.constraint), `[negativa] un pago sin concepto, o una custodia clasificada como pago → ${dijo(e2d)}`);
      const e3 = await intento(trx, () => emitir(trx, orden({ expires_at: new Date(Date.now() - 1000).toISOString() })));
      ok(!!e3 && e3.constraint === 'cashbook_orden_sin_plazo', `[negativa] una orden ya vencida al nacer → ${dijo(e3)}`);

      console.log('\n── 4. D10: la app sólo lee ──');
      if (hayRol) {
        const e4 = await intento(trx, () => trx('cashbook.withdrawal_orders').where({ code: v.code }).update({ used_minor: 0 }));
        ok(!!e4 && e4.code === '42501', `[negativa] app_runtime no escribe la tabla a mano → 42501 (${dijo(e4)})`);
      }

      console.log('\n── 5. ⛔ MUTACIÓN: sin el candado del saldo, el «de más» pasaría ──');
      if (hayRol) await trx.raw('RESET ROLE');
      const m = await intento(trx, async () => {
        await trx.raw('ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT cashbook_orden_saldo');
        await trx.raw(`UPDATE cashbook.withdrawal_orders SET used_minor = amount_minor + 1 WHERE code = ?`, [v.code]);
      });
      ok(m === null, `sin la regla, el saldo sí se pasa (${dijo(m)}): la sección 2 mide el candado`);

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('\n  ✓ rollback aplicado — la base queda como estaba');
  } catch (e) {
    fail++;
    console.error('\n💥', e.message, '\n', e.stack);
  } finally {
    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
    await knex.destroy();
  }
})();
