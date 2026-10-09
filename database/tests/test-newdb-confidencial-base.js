/* eslint-disable no-console */
/**
 * `[MSH.1]` Mesa de Servicio — la BASE de la cola confidencial de RH. Smoke DB-direct con ROLLBACK: cero efecto real.
 *
 *   1. Esquema y valores de siempre: las 5 columnas nuevas existen; TI y Mantenimiento quedan EXACTAMENTE como estaban
 *      (nada confidencial, con prioridad y SLA, mínimo 5); ningún ticket existente es confidencial.
 *   2. `report_min_cases` ≥ 1 (CHECK).
 *   3. INSERT: la marca del ticket se COPIA de su cola y no se puede falsificar (ni hacia arriba ni hacia abajo).
 *   4. UPDATE de la marca: no cambia NUNCA (ni true→false ni false→true).
 *   5. Mover de cola: sólo a una cola de la MISMA clase (el invariante `ticket.confidential = cola.confidential`).
 *   6. La marca de una COLA con tickets no se cambia (con uno dado de baja también); una cola vacía sí.
 *   7. Lo mismo ACTUANDO COMO `app_runtime` (un superusuario se salta el RLS y los permisos: sin `SET LOCAL ROLE` este bloque mediría nada).
 *
 * ⚠️ «Un gate sin prueba negativa es una intención» (ADR-056): cada defensa se rompe a propósito UNA vez, exigiendo el SQLSTATE exacto,
 * y cada negativa trae su CONTROL POSITIVO (la misma operación permitida SÍ pasa): sin él, un rechazo podría venir de una consulta rota.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-confidencial-base');

const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_msh');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || e.message; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_msh');
  return code;
}

(async () => {
  try {
    console.log('\n1 — esquema y lo de siempre');
    const cols = (await knex.raw(`SELECT table_name, column_name, column_default FROM information_schema.columns WHERE table_schema='servicedesk' AND ((table_name='queues' AND column_name IN ('confidential','uses_priority','sla_enabled','report_min_cases')) OR (table_name='requests' AND column_name='confidential'))`)).rows;
    ok(cols.length === 5, 'las 5 columnas existen (4 en queues, 1 en requests)');
    const trg = (await knex.raw(`SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname='servicedesk' AND NOT t.tgisinternal AND t.tgname LIKE 'trg_%confidencial'`)).rows.map((r) => r.tgname).sort();
    ok(JSON.stringify(trg) === JSON.stringify(['trg_queues_protege_confidencial', 'trg_requests_fija_confidencial', 'trg_requests_protege_confidencial']), 'los 3 triggers existen', JSON.stringify(trg));
    const reales = await knex('servicedesk.queues').where({ tenant_id: T }).whereIn('code', ['ti', 'mantenimiento']).select('code', 'confidential', 'uses_priority', 'sla_enabled', 'report_min_cases');
    ok(reales.length >= 1 && reales.every((q) => q.confidential === false && q.uses_priority === true && q.sla_enabled === true && Number(q.report_min_cases) === 5), '⭐ TI y Mantenimiento quedan EXACTAMENTE como estaban: no confidenciales, con prioridad y SLA, mínimo 5', JSON.stringify(reales));
    const marcados = await knex('servicedesk.requests').where({ confidential: true }).count({ n: '*' }).first();
    ok(Number(marcados.n) === 0, '⭐ ningún ticket existente es confidencial (la migración no cambió a nadie)');

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
      const nuevaCola = async (o = {}) => (await trx('servicedesk.queues').insert({ tenant_id: T, code: `smoke_msh_${++n}_${Date.now() % 100000}`, name: `SMOKE MSH ${n}`, sort_order: 990 + n, ...o }).returning('id'))[0].id;
      const ticket = (queue_id, o = {}) => trx('servicedesk.requests').insert({
        tenant_id: T, folio: `SRV-2098-${String(50000 + ++n)}`, queue_id, category_id: cat.id, title: 'Smoke MSH.1', requester_id: usuario.id, ...o,
      }).returning('*');

      const qConf = await nuevaCola({ confidential: true });
      const qConf2 = await nuevaCola({ confidential: true });
      const qNormal = await nuevaCola({});
      const qVacia = await nuevaCola({});

      console.log('\n2 — report_min_cases');
      ok((await codigo(trx, () => nuevaCola({ report_min_cases: 0 }))) === '23514', '⭐ un mínimo de 0 casos → CHECK (un agregado de 0 no protege a nadie)');
      ok((await codigo(trx, () => nuevaCola({ report_min_cases: -3 }))) === '23514', 'un mínimo negativo → CHECK');
      ok((await codigo(trx, () => nuevaCola({ report_min_cases: 1 }))) === null, 'CONTROL: un mínimo de 1 SÍ entra');
      ok((await codigo(trx, () => nuevaCola({ report_min_cases: 10, uses_priority: false, sla_enabled: false }))) === null, 'CONTROL: una cola sin prioridad ni SLA y con mínimo 10 SÍ entra (la configuración de RH)');

      console.log('\n3 — INSERT: la marca se copia de la cola y no se falsifica');
      const [enConf] = await ticket(qConf);
      ok(enConf.confidential === true, '⭐ un ticket en una cola confidencial NACE confidencial (sin que nadie lo pida)');
      const [enNormal] = await ticket(qNormal);
      ok(enNormal.confidential === false, 'un ticket en una cola normal nace no confidencial');
      const [falso1] = await ticket(qConf, { confidential: false });
      ok(falso1.confidential === true, '⛔ intentar crear un ticket «NO confidencial» en una cola confidencial → la base lo deja confidencial (no se puede evadir la marca)');
      const [falso2] = await ticket(qNormal, { confidential: true });
      ok(falso2.confidential === false, '⛔ intentar declarar «confidencial» un ticket de una cola normal → la base lo deja normal (el cliente no decide)');
      ok((await codigo(trx, () => ticket('00000000-0000-0000-0000-0000000000aa'))) === '23503', 'CONTROL: una cola inexistente la sigue rechazando la FK (el trigger no la tapa)');

      console.log('\n4 — UPDATE: la marca no cambia nunca');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enConf.id }).update({ confidential: false }))) === '23514', '⭐ quitar la marca a un ticket confidencial → 23514');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enNormal.id }).update({ confidential: true }))) === '23514', '⛔ poner la marca a un ticket normal → 23514 (no se «promueve» a confidencial)');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enConf.id }).update({ confidential: true }))) === null, 'CONTROL: «cambiar» a su mismo valor no es un cambio y pasa');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enConf.id }).update({ title: 'Otro título', updated_at: trx.fn.now() }))) === null, 'CONTROL: cualquier otro UPDATE del ticket confidencial (título, estado, SLA…) sigue funcionando');

      console.log('\n5 — mover de cola: sólo a una de la misma clase');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enConf.id }).update({ queue_id: qNormal }))) === '23514', '⭐ un ticket confidencial NO sale a una cola normal (la que ve TI) → 23514');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enNormal.id }).update({ queue_id: qConf }))) === '23514', '⭐ un ticket normal NO entra a una cola confidencial (quedaría con la marca equivocada) → 23514');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enConf.id }).update({ queue_id: qConf2 }))) === null, 'CONTROL: confidencial → OTRA confidencial SÍ (quién puede es regla de MSH.2: sólo coordinación a coordinación)');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enNormal.id }).update({ queue_id: qVacia }))) === null, 'CONTROL: normal → normal SÍ (el traslado de siempre entre TI y Mantenimiento no cambia)');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: enConf.id }).update({ queue_id: '00000000-0000-0000-0000-0000000000aa' }))) === '23503', 'CONTROL: una cola inexistente la rechaza la FK, no el trigger');

      console.log('\n6 — la marca de una COLA con tickets no se cambia');
      ok((await codigo(trx, () => trx('servicedesk.queues').where({ id: qConf }).update({ confidential: false }))) === '23514', '⭐ apagar la marca de una cola con tickets confidenciales → 23514 (los dejaría dentro de una cola normal)');
      ok((await codigo(trx, () => trx('servicedesk.queues').where({ id: qNormal }).update({ confidential: true }))) === '23514', '⭐ encender la marca de una cola con tickets normales → 23514');
      ok((await codigo(trx, () => trx('servicedesk.queues').where({ id: qConf }).update({ confidential: true, name: 'SMOKE renombrada' }))) === null, 'CONTROL: otros cambios de la cola (nombre, orden) siguen funcionando');
      ok((await codigo(trx, () => trx('servicedesk.queues').where({ id: qVacia }).update({ confidential: true }))) === null, '⭐ CONTROL: una cola SIN tickets sí se ajusta (es lo que hace la siembra de RH)');
      const [baja] = await ticket(qConf2);
      await trx('servicedesk.requests').where({ id: baja.id }).update({ deleted_at: trx.fn.now() });
      const qSoloBaja = await nuevaCola({ confidential: true });
      const [soloBaja] = await ticket(qSoloBaja);
      await trx('servicedesk.requests').where({ id: soloBaja.id }).update({ deleted_at: trx.fn.now() });
      ok((await codigo(trx, () => trx('servicedesk.queues').where({ id: qSoloBaja }).update({ confidential: false }))) === '23514', '⛔ una cola cuyo único ticket está dado de baja TAMBIÉN cuenta (cuenta todos: el dato sigue ahí)');

      console.log('\n7 — lo mismo actuando como app_runtime (el RLS y los permisos reales)');
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const rQ = (await trx('servicedesk.queues').insert({ tenant_id: T, code: `smoke_msh_rt_${Date.now() % 100000}`, name: 'SMOKE MSH rt', sort_order: 999, confidential: true }).returning('id'))[0].id;
      const [rTk] = await trx('servicedesk.requests').insert({ tenant_id: T, folio: 'SRV-2098-59990', queue_id: rQ, category_id: cat.id, title: 'rt', requester_id: usuario.id, confidential: false }).returning('*');
      ok(rTk.confidential === true, '⭐ el runtime crea un ticket en cola confidencial pidiendo «false» → nace confidencial (el trigger lee la cola con el RLS del runtime)');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: rTk.id }).update({ confidential: false }))) === '23514', '⭐ el runtime NO puede quitar la marca (aunque tenga UPDATE sobre la tabla)');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: rTk.id }).update({ queue_id: cola.id }))) === '23514', '⭐ ni sacar el ticket a TI');
      ok((await codigo(trx, () => trx('servicedesk.queues').where({ id: rQ }).update({ confidential: false }))) === '23514', '⭐ ni apagar la marca de su cola');
      ok((await codigo(trx, () => trx('servicedesk.requests').where({ id: rTk.id }).update({ title: 'ok', updated_at: trx.fn.now() }))) === null, 'CONTROL: y todo lo demás sigue funcionando como runtime');
      await trx.raw('RESET ROLE');
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
