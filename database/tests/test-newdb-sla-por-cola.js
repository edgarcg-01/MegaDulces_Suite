/* eslint-disable no-console */
/**
 * `[MS.7.2]` SLA por cola (`20261007250000_servicedesk_sla_por_cola.js`). Smoke DB-direct; todo lo que escribe corre dentro
 * de una transacción que se REVIERTE.
 *
 * Qué defiende (cada negativa con su control positivo, porque un rechazo puede venir de una consulta rota y no del CHECK):
 *   1. La política GENERAL no cambió: 4 filas con `queue_id` NULL y los mismos plazos de siempre (TI no se entera).
 *   2. La unicidad es por `(tenant, cola, prioridad)` con NULL tratado como «la general»: un UNIQUE normal dejaría repetir
 *      `(tenant, NULL, prioridad)` — la negativa que importa es **no poder duplicar la general**.
 *   3. Una cola sólo puede tener UNA política por prioridad, y sólo de una cola que existe (FK).
 *   4. Las invariantes de siempre siguen (primera respuesta ≤ resolución; reloj business/calendar).
 *   5. Los plazos propios de Mantenimiento (decisión de Sistemas: horario hábil), si la cola está sembrada.
 *   6. Restricción de permisos REAL, actuando como `app_runtime`.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-sla-por-cola');

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

/** Corre `fn` en un SAVEPOINT y devuelve el SQLSTATE del error (null si no falló). */
async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_sla');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || e.message; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_sla');
  return code;
}

(async () => {
  try {
    console.log('\n1 — la política general no cambió');
    const generales = await knex('servicedesk.sla_policies').where({ tenant_id: T }).whereNull('queue_id').orderBy('first_response_minutes');
    ok(generales.length === 4, '4 políticas generales (queue_id NULL), una por prioridad');
    const g = Object.fromEntries(generales.map((r) => [r.priority, r]));
    ok(g.urgente?.clock === 'calendar' && g.urgente?.first_response_minutes === 30 && g.urgente?.resolution_minutes === 240, 'TI sigue igual: la urgente corre CORRIDA (30 min / 4 h)');

    const cola = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');

    console.log('\n2 — unicidad: NULL cuenta como «la general»');
    await knex.transaction(async (trx) => {
      const ins = (o) => trx('servicedesk.sla_policies').insert({ tenant_id: T, priority: 'media', first_response_minutes: 10, resolution_minutes: 20, clock: 'business', ...o });
      ok((await codigo(trx, () => ins({ queue_id: null }))) === '23505', '⭐ NO se puede duplicar la política GENERAL (queue_id NULL) — un UNIQUE normal lo dejaría pasar');
      ok((await codigo(trx, () => ins({ queue_id: cola.id }))) === null, 'CONTROL: una política PROPIA de una cola sí entra');
      await ins({ queue_id: cola.id });
      ok((await codigo(trx, () => ins({ queue_id: cola.id }))) === '23505', '⭐ ni dos políticas de la misma cola para la misma prioridad');
      // Una cola NUEVA (se revierte): otra cola SÍ puede tener su propia política para la misma prioridad.
      const [{ id: otraId }] = await trx('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_sla_db', name: 'SMOKE SLA db', sort_order: 999 }).returning('id');
      ok((await codigo(trx, () => ins({ queue_id: otraId }))) === null, 'CONTROL: OTRA cola sí puede tener la suya para la misma prioridad');
      ok((await codigo(trx, () => ins({ queue_id: cola.id, priority: 'alta' }))) === null, 'CONTROL: la misma cola con OTRA prioridad sí entra');

      console.log('\n3 — la cola debe existir');
      ok((await codigo(trx, () => ins({ queue_id: '00000000-0000-0000-0000-0000000000aa', priority: 'baja' }))) === '23503', '⭐ una cola inexistente se rechaza (FK compuesta)');

      console.log('\n4 — las invariantes de siempre');
      ok((await codigo(trx, () => ins({ queue_id: cola.id, priority: 'baja', first_response_minutes: 500, resolution_minutes: 100 }))) === '23514', 'primera respuesta MAYOR que la resolución → CHECK');
      ok((await codigo(trx, () => ins({ queue_id: cola.id, priority: 'baja', clock: 'cuando-sea' }))) === '23514', 'un reloj que no es business/calendar → CHECK');
      ok((await codigo(trx, () => ins({ queue_id: cola.id, priority: 'baja' }))) === null, 'CONTROL: la misma fila sin el defecto SÍ entra');
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    console.log('\n5 — los plazos propios de Mantenimiento (horario hábil)');
    const mto = await knex('servicedesk.queues').where({ tenant_id: T, code: 'mantenimiento' }).first('id');
    if (!mto) {
      console.log('  ⓘ NO MEDIDO: la cola de Mantenimiento no está sembrada en este destino');
    } else {
      const m = Object.fromEntries((await knex('servicedesk.sla_policies').where({ tenant_id: T, queue_id: mto.id })).map((r) => [r.priority, r]));
      ok(Object.keys(m).length === 4, 'Mantenimiento tiene sus 4 plazos propios');
      ok(Object.values(m).every((r) => r.clock === 'business'), '⭐ TODOS en horario hábil (decisión de Sistemas)');
      ok(m.urgente?.first_response_minutes === 60 && m.urgente?.resolution_minutes === 240, 'Urgente 60 / 240');
      ok(m.alta?.first_response_minutes === 240 && m.alta?.resolution_minutes === 480, 'Alta 240 / 480 (el «24 h» del plan tomado como 1 día hábil — por confirmar con Frank)');
      ok(m.media?.first_response_minutes === 480 && m.media?.resolution_minutes === 1440, 'Media 480 / 1,440');
      ok(m.baja?.first_response_minutes === 1440 && m.baja?.resolution_minutes === 4800, 'Baja 1,440 / 4,800');
      ok(g.urgente?.clock === 'calendar', '⛔ y la urgente de TI SIGUE corrida: lo de Mantenimiento no se filtró a la general');
    }

    console.log('\n6 — permisos reales (app_runtime)');
    await knex.transaction(async (trx) => {
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const veo = await trx('servicedesk.sla_policies').count({ n: '*' }).first();
      ok(Number(veo.n) >= 4, 'el runtime LEE las políticas de su tenant');
      ok((await codigo(trx, () => trx('servicedesk.sla_policies').where({ priority: 'media' }).whereNull('queue_id').update({ updated_at: trx.fn.now() }))) === null, 'CONTROL: el runtime SÍ edita una política');
      ok((await codigo(trx, () => trx('servicedesk.sla_policies').where({ priority: 'media' }).whereNotNull('queue_id').del())) === null, 'y SÍ puede borrar un plazo propio de cola (volver a heredar)');
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
