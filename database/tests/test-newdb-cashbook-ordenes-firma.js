/* eslint-disable no-console */
/**
 * `[LE.4.10]` — La orden que espera la firma de Tesorería, contra Postgres real.
 *
 * Mide la migración `20261102143213_le410_orden_por_firmar_y_vale_una_vez`:
 *  · por firmar nace SIN código y ya toma el documento (no se pide dos veces);
 *  · firma un puesto que firma caja, nunca quien la pidió; firmar le da el código;
 *  · un rechazo dice por qué y libera el documento;
 *  · un pago todo del cajón lleva una orden de $0 que nace usada (sólo un pago puede ser de $0);
 *  · un vale ampara un pago; una llave repetida devuelve la misma orden y con otro contenido se rechaza;
 *  · lo que nadie firmó a tiempo vence;
 *  · MUTACIÓN: sin el candado del código, una orden vigente sin código sí pasaría.
 * Siembra como superusuario, escribe como `app_runtime`. Todo en una transacción que se deshace.
 */
const crypto = require('crypto');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cashbook-ordenes-firma');

const uuid = () => crypto.randomUUID();
const T = uuid();
const CAJERA = uuid();
const TESORERIA = uuid();
const OTRO = uuid();
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
const es = (e, c) => !!e && e.constraint === c;
const enUnaHora = () => new Date(Date.now() + 3600e3).toISOString();
const pago = (doc, over = {}) => ({ actor: { kind: 'persona', user_id: CAJERA }, kind: 'pago', amount_minor: '78000', source_ref: doc,
  classification: { tipo: 'pago', concepto: '201', documento: doc }, expires_at: enUnaHora(), ...over });
const emitir = async (trx, p) => (await trx.raw('SELECT cashbook.issue_order(?::jsonb) AS r', [JSON.stringify(p)])).rows[0].r;
const firmar = async (trx, id, quien) => (await trx.raw('SELECT cashbook.sign_order(?, ?, NULL, ?) AS r', [id, quien, enUnaHora()])).rows[0].r;
const estado = async (trx, id) => (await trx.raw('SELECT state, code FROM cashbook.withdrawal_orders WHERE id = ?', [id])).rows[0];

(async () => {
  try {
    console.log('\n── 0. La migración está aplicada ──');
    const { rows: [h] } = await knex.raw(`SELECT to_regprocedure('cashbook.sign_order(uuid, uuid, uuid, timestamptz)') IS NOT NULL AS f`);
    if (!h.f) { ok(false, 'la migración 20261102143213 NO está aplicada en esta base: nada se puede medir'); return; }
    ok(true, 'firmar y rechazar existen');

    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;
    await knex.transaction(async (trx) => {
      console.log('\n── 1. Siembra: una cajera, Tesorería (puesto que firma caja) y alguien sin ese puesto ──');
      for (const [id, nombre, puesto] of [[CAJERA, 'cajera', 'cajera_general'], [TESORERIA, 'tesoreria', 'le410_tesoreria'], [OTRO, 'otro', 'le410_otro']]) {
        await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, kind, position_code, password_hash, created_at, updated_at)
          VALUES (?, ?, ?, 'tesoreria', true, 'interno', ?, 'prueba-sin-login', now(), now())`, [id, T, `le410_${nombre}_${id.slice(0, 4)}`, puesto]);
      }
      await trx.raw(`INSERT INTO identity.position_responsibilities (id, tenant_id, position_code, responsibility_key, es_principal, created_at, updated_at)
        VALUES (gen_random_uuid(), ?, 'le410_tesoreria', 'finanzas.caja_firma', true, now(), now())`, [T]);
      ok(true, 'sembrados');

      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      else skip('sin app_runtime: corre como superusuario.');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      console.log('\n── 2. Por firmar: sin código, y el documento ya está tomado ──');
      const DOC = '00|X-D-26|0023782|0011';
      const p = await emitir(trx, pago(DOC, { por_firmar: true, act: { recibe: 'Nómina CEDIS' } }));
      ok(p.state === 'por_firmar' && p.code === null && p.seq === null, `nace por firmar y sin código (${JSON.stringify(p)})`);
      const r0 = (await trx.raw('SELECT cashbook.consume_order(?, 78000, now()) AS r', ['ZZZZ-1'])).rows[0].r;
      ok(r0.ok === false, '[negativa] la máquina no tiene código que aceptar');
      const e1 = await intento(trx, () => emitir(trx, pago(DOC)));
      ok(es(e1, 'cashbook_orden_documento_una_vez'), `[negativa] mientras espera firma, el documento no se vuelve a ordenar → ${dijo(e1)}`);

      console.log('\n── 3. Firmar: un puesto que firma caja, nunca quien la pidió ──');
      const e2 = await intento(trx, () => firmar(trx, p.id, CAJERA));
      ok(es(e2, 'cashbook_orden_firma_otro'), `[negativa] la cajera no firma su propia orden → ${dijo(e2)}`);
      const e3 = await intento(trx, () => firmar(trx, p.id, OTRO));
      ok(es(e3, 'cashbook_firma_por_puesto'), `[negativa] alguien sin puesto que firma caja → ${dijo(e3)}`);
      const f = await firmar(trx, p.id, TESORERIA);
      ok(f.state === 'vigente' && /^[A-HJ-NP-Z2-9]{4}-\d$/.test(f.code) && f.act?.recibe === 'Nómina CEDIS',
        `Tesorería firma: nace el código ${f.code} y vuelve lo capturado`);
      const r1 = (await trx.raw('SELECT cashbook.consume_order(?, 78000, now()) AS r', [f.code])).rows[0].r;
      ok(r1.ok === true && r1.kind === 'pago', 'con la firma, la máquina ya acepta el código');
      const e4 = await intento(trx, () => firmar(trx, p.id, TESORERIA));
      ok(es(e4, 'cashbook_orden_no_por_firmar'), `[negativa] no se firma dos veces → ${dijo(e4)}`);

      console.log('\n── 4. Rechazar: con motivo, y el documento queda libre ──');
      const DOC2 = '00|X-D-26|0023790|0011';
      const q = await emitir(trx, pago(DOC2, { por_firmar: true }));
      const e5 = await intento(trx, () => trx.raw('SELECT cashbook.reject_order(?, ?, ?)', [q.id, TESORERIA, '  ']));
      ok(es(e5, 'cashbook_orden_rechazo_con_motivo'), `[negativa] un rechazo sin motivo → ${dijo(e5)}`);
      await trx.raw('SELECT cashbook.reject_order(?, ?, ?)', [q.id, TESORERIA, 'no trae comprobante']);
      ok((await estado(trx, q.id)).state === 'anulada', 'rechazada queda anulada');
      const q2 = await emitir(trx, pago(DOC2, { por_firmar: true }));
      ok(q2.state === 'por_firmar', 'el documento rechazado se puede pedir otra vez');

      console.log('\n── 5. Un pago todo del cajón: orden de $0 que nace usada ──');
      const z = await emitir(trx, pago('00|X-D-26|0023787|0011', { amount_minor: '0' }));
      ok(z.state === 'usada' && !!z.code, `nace usada (${z.state}) y toma el documento`);
      const e6 = await intento(trx, () => emitir(trx, { ...pago('x'), kind: 'custodia', source_ref: null, amount_minor: '0',
        classification: { tipo: 'custodia', empleado: 'e-1', nombre: 'Compras' } }));
      ok(es(e6, 'cashbook_orden_monto'), `[negativa] sólo un pago puede ser de $0 → ${dijo(e6)}`);

      console.log('\n── 6. Un vale, un pago; una llave, una orden ──');
      const VALE = uuid();
      const conVale = (doc) => pago(doc, { classification: { tipo: 'pago', concepto: '201', documento: doc, vale: VALE } });
      await emitir(trx, conVale('00|X-D-26|0023791|0011'));
      const e7 = await intento(trx, () => emitir(trx, conVale('00|X-D-26|0023792|0011')));
      ok(es(e7, 'cashbook_orden_vale_una_vez'), `[negativa] el mismo vale no ampara dos pagos → ${dijo(e7)}`);
      const KEY = uuid();
      const a = await emitir(trx, pago('00|X-D-26|0023793|0011', { idempotency_key: KEY }));
      const b = await emitir(trx, pago('00|X-D-26|0023793|0011', { idempotency_key: KEY }));
      ok(a.id === b.id && b.repetida === true, 'un reintento con la misma llave devuelve la misma orden');
      const e8 = await intento(trx, () => emitir(trx, pago('00|X-D-26|0023794|0011', { idempotency_key: KEY })));
      ok(es(e8, 'cashbook_peticion_reusada'), `[negativa] la misma llave con otro documento → ${dijo(e8)}`);

      console.log('\n── 7. Lo que nadie firmó a tiempo vence ──');
      if (hayRol) await trx.raw('RESET ROLE');
      await trx.raw(`UPDATE cashbook.withdrawal_orders SET expires_at = now() - interval '1 minute' WHERE id = ?`, [q2.id]);
      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      const e9 = await intento(trx, () => firmar(trx, q2.id, TESORERIA));
      ok(es(e9, 'cashbook_orden_vencida'), `[negativa] firmar fuera de plazo → ${dijo(e9)}`);
      await trx.raw('SELECT cashbook.expire_orders()');
      ok((await estado(trx, q2.id)).state === 'vencida', 'el barrido de vencidas también vence lo que esperaba firma');

      console.log('\n── 8. D10: la app sólo lee ──');
      if (hayRol) {
        const e10 = await intento(trx, () => trx('cashbook.withdrawal_orders').where({ id: q2.id }).update({ state: 'vigente' }));
        ok(!!e10 && e10.code === '42501', `[negativa] app_runtime no firma a mano → 42501 (${dijo(e10)})`);
      }

      console.log('\n── 9. ⛔ MUTACIÓN: sin el candado del código, una orden vigente SIN código pasaría ──');
      if (hayRol) await trx.raw('RESET ROLE');
      const sinCandado = await intento(trx, () => trx.raw(`UPDATE cashbook.withdrawal_orders SET state = 'vigente' WHERE id = ?`, [q2.id]));
      ok(es(sinCandado, 'cashbook_orden_codigo_al_firmar'), `con el candado: vigente sin código → ${dijo(sinCandado)}`);
      const m = await intento(trx, async () => {
        await trx.raw('ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT cashbook_orden_codigo_al_firmar');
        await trx.raw(`UPDATE cashbook.withdrawal_orders SET state = 'vigente' WHERE id = ?`, [q2.id]);
      });
      ok(m === null, `sin el candado sí pasa (${dijo(m)}): la regla es la que lo impide`);

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
