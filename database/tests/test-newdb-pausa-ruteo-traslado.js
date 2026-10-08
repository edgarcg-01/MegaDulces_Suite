/* eslint-disable no-console */
/**
 * `[MS.7.5]` Mesa de Servicio — la base de la pausa con motivo, el ruteo por ubicación y el traslado entre colas.
 * Smoke DB-direct con ROLLBACK: cero efecto real.
 *
 *   1. Existen la columna `pause_reason`, `warehouse_code` y los CHECK nuevos.
 *   2. `pause_reason`: sólo los 5 motivos, y SÓLO mientras el ticket está en espera (un motivo huérfano de una pausa que terminó
 *      sería un dato que miente). Todo lo existente sigue válido (sin motivo, en cualquier estado).
 *   3. `routing_rules`: el disparador es categoría, palabras O ubicación; una regla sin ninguno sigue siendo un typo.
 *   4. `request_messages.kind` admite `transfer`; un tipo inventado no; la nota interna sigue sin poder ser pública.
 *
 * ⚠️ «Un gate sin prueba negativa es una intención» (ADR-056): cada CHECK se rompe a propósito y cada negativa trae su control.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pausa-ruteo-traslado');

const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_pr');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || e.message; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_pr');
  return code;
}

(async () => {
  try {
    console.log('\n1 — schema');
    const cols = (await knex.raw(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='servicedesk' AND ((table_name='requests' AND column_name='pause_reason') OR (table_name='routing_rules' AND column_name='warehouse_code'))`)).rows;
    ok(cols.length === 2, 'requests.pause_reason y routing_rules.warehouse_code existen');
    const cks = (await knex.raw(`SELECT conname FROM pg_constraint WHERE conname IN ('requests_pause_reason_ck','requests_pause_reason_state_ck','routing_rules_trigger_ck','request_messages_kind_ck')`)).rows;
    ok(cks.length === 4, 'los 4 CHECK (motivo, motivo⇔espera, disparador, tipo de mensaje) existen');
    const huerfanos = await knex('servicedesk.requests').whereNotNull('pause_reason').count({ n: '*' }).first();
    ok(Number(huerfanos.n) === 0, '⭐ ningún ticket existente trae motivo (la migración sólo amplía: todo lo de antes sigue válido)');

    const cola = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');
    const usuario = await knex('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
    const cat = await knex('servicedesk.categories').where({ tenant_id: T, queue_id: cola.id }).first('id');
    if (!usuario || !cat) {
      console.log('  ⚠️  NO MEDIDO: no hay usuario o categoría con qué probar el ticket');
      fail++;
      return;
    }

    await knex.transaction(async (trx) => {
      let n = 0;
      const tk = (o = {}) => trx('servicedesk.requests').insert({
        tenant_id: T, folio: `SRV-2099-${String(60000 + ++n)}`, queue_id: cola.id, category_id: cat.id, title: 'Smoke MS.7.5', requester_id: usuario.id, ...o,
      }).returning('*');
      const enEspera = (o = {}) => tk({ status: 'en_espera', paused_at: trx.fn.now(), ...o });

      console.log('\n2 — pause_reason');
      for (const m of ['proveedor', 'refaccion', 'aprobacion', 'solicitante', 'otro']) {
        ok((await codigo(trx, () => enEspera({ pause_reason: m }))) === null, `CONTROL: el motivo «${m}» en espera SÍ entra`);
      }
      ok((await codigo(trx, () => enEspera({ pause_reason: 'porque_si' }))) === '23514', '⭐ un motivo inventado → CHECK');
      ok((await codigo(trx, () => enEspera({ pause_reason: '' }))) === '23514', 'un motivo vacío → CHECK');
      ok((await codigo(trx, () => tk({ pause_reason: 'proveedor' }))) === '23514', '⭐ un motivo en un ticket que NO está en espera → CHECK (sería un dato que miente)');
      ok((await codigo(trx, () => tk({ status: 'en_proceso', assigned_to: usuario.id, assigned_at: trx.fn.now(), pause_reason: 'otro' }))) === '23514', 'ni siquiera «en proceso» puede traer motivo');
      ok((await codigo(trx, () => enEspera({}))) === null, 'CONTROL: en espera SIN motivo SÍ entra (lo de antes sigue válido)');
      ok((await codigo(trx, () => tk({}))) === null, 'CONTROL: un ticket nuevo sin motivo SÍ entra');
      // La pausa termina: el motivo tiene que irse con ella.
      const [t] = await enEspera({ pause_reason: 'refaccion' });
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: t.id }).update({ status: 'en_proceso', paused_at: null, assigned_to: usuario.id, assigned_at: trx.fn.now() }))) === '23514', '⭐ reanudar SIN limpiar el motivo → CHECK (el código debe quitarlo)');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: t.id }).update({ status: 'en_proceso', paused_at: null, pause_reason: null, assigned_to: usuario.id, assigned_at: trx.fn.now() }))) === null, 'CONTROL: reanudar limpiando el motivo SÍ');

      console.log('\n3 — routing_rules: el disparador');
      const rr = (o = {}) => trx('servicedesk.routing_rules').insert({ tenant_id: T, name: 'smoke regla', assignee_id: usuario.id, ...o });
      ok((await codigo(trx, () => rr({}))) === '23514', '⭐ una regla SIN categoría, palabras ni ubicación sigue siendo un typo → CHECK');
      ok((await codigo(trx, () => rr({ warehouse_code: 'OF' }))) === null, '⭐ una regla sólo por UBICACIÓN ahora SÍ entra');
      ok((await codigo(trx, () => rr({ keywords: ['impresora'] }))) === null, 'CONTROL: sólo por palabras sigue entrando');
      ok((await codigo(trx, () => rr({ category_id: cat.id }))) === null, 'CONTROL: sólo por categoría sigue entrando');
      ok((await codigo(trx, () => rr({ warehouse_code: 'x'.repeat(21) }))) !== null, 'una ubicación de más de 20 caracteres no cabe');

      console.log('\n4 — request_messages.kind');
      const [req] = await tk({});
      const msg = (o = {}) => trx('servicedesk.request_messages').insert({ tenant_id: T, request_id: req.id, kind: 'comment', body: 'hola', ...o });
      ok((await codigo(trx, () => msg({ kind: 'transfer', visibility: 'public', body: 'Pasó de TI a Mantenimiento', meta: JSON.stringify({ from: 'ti', to: 'mantenimiento' }) }))) === null, '⭐ un mensaje de traslado SÍ entra');
      ok((await codigo(trx, () => msg({ kind: 'traspaso' }))) === '23514', '⭐ un tipo inventado → CHECK');
      for (const k of ['comment', 'status', 'assignment', 'priority', 'system']) {
        ok((await codigo(trx, () => msg({ kind: k }))) === null, `CONTROL: «${k}» (de antes) sigue entrando`);
      }
      ok((await codigo(trx, () => msg({ kind: 'internal_note', visibility: 'public' }))) === '23514', '⛔ la nota interna sigue sin poder ser pública');
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
  } catch (e) {
    fail++;
    console.log('\n  ✗ EXCEPCIÓN:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
