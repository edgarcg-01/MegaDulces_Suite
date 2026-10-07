/* eslint-disable no-console */
/**
 * `[MS.7.14]` Siembra de la cola «Mantenimiento» (`20261007120000_servicedesk_seed_mantenimiento.js`). Smoke DB-direct:
 * todo lo que escribe corre dentro de una transacción que se REVIERTE.
 *
 * Qué defiende (cada bloque con su negativa, y cada negativa con su control positivo):
 *   1. La cola existe, **APAGADA** y **sin miembros**: encendida y sin nadie, cada ticket nacería en una bandeja que nadie ve.
 *   2. Las 11 categorías del plan, con los valores por validar (prioridad `media`, exigen ubicación) y activas.
 *   3. **No finge lo que no tiene**: `priority_model` sigue en `impacto` (la lógica de `riesgo_operacion` es MS.7.7) y no
 *      hay SLA propio todavía (MS.7.2): la cola no CLAMA algo que el código no aplica.
 *   4. Idempotente: re-correrla NO pisa lo que la coordinación ya ajustó (nombre de una categoría, cola encendida).
 *   5. El `down` conserva lo que tiene historia (un ticket ya levantado es registro) y retira lo que no.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-mantenimiento-seed');
const seed = require('../migrations-newdb/20261007120000_servicedesk_seed_mantenimiento.js');

const T = '00000000-0000-0000-0000-00000000d01c';
const ESPERADAS = [
  'electrico_iluminacion', 'climatizacion_refrigeracion', 'plomeria', 'obra_civil_pintura', 'herreria_puertas_cortinas',
  'mobiliario_anaqueles', 'equipo_almacen', 'seguridad_proteccion_civil', 'plagas_limpieza', 'fachada_rotulacion', 'estacionamiento',
];

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

(async () => {
  try {
    // La siembra es parte de las migraciones: se asegura (idempotente) y se mide el estado resultante.
    await knex.transaction((t) => seed.up(t));

    console.log('\n1 — la cola');
    const cola = await knex('servicedesk.queues').where({ tenant_id: T, code: 'mantenimiento' }).first();
    ok(!!cola, 'existe la cola «mantenimiento»');
    ok(cola?.name === 'Mantenimiento', 'se llama «Mantenimiento»');
    ok(cola?.active === false, '⭐ nace APAGADA (sin coordinación, encendida sería una bandeja que nadie ve)');
    const miembros = await knex('servicedesk.queue_members').where({ queue_id: cola.id }).count({ n: '*' }).first();
    ok(Number(miembros.n) === 0, '⭐ nace SIN miembros (la coordinación la nombra un administrador desde la pantalla)');
    const ti = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('active');
    ok(ti?.active === true, 'CONTROL: la cola de TI sigue encendida (la siembra no la toca)');

    console.log('\n2 — las 11 categorías');
    const cats = await knex('servicedesk.categories').where({ queue_id: cola.id }).orderBy('sort_order');
    ok(cats.length === 11, `11 categorías (hay ${cats.length})`);
    ok(JSON.stringify(cats.map((c) => c.code)) === JSON.stringify(ESPERADAS), 'son las del plan, en su orden');
    ok(cats.every((c) => c.default_priority === 'media'), 'todas con prioridad por defecto «media» (el plan no fija ninguna; por validar con Frank)');
    ok(cats.every((c) => c.requires_branch === true), 'todas exigen ubicación (una falla de mantenimiento es EN un sitio)');
    ok(cats.every((c) => c.active === true && c.deleted_at === null), 'todas activas (la cola apagada es la que las esconde)');
    const ajenas = await knex('servicedesk.categories').whereIn('code', ESPERADAS).whereNot('queue_id', cola.id).count({ n: '*' }).first();
    ok(Number(ajenas.n) === 0, 'CONTROL: ninguna de esas categorías se coló en otra cola');

    console.log('\n3 — no finge lo que todavía no existe');
    ok(cola.priority_model === 'impacto', '⭐ priority_model sigue en «impacto»: la lógica de riesgo × operación es MS.7.7 y la cola no clama una matriz que no se aplica');
    const slaCol = await knex.raw(`SELECT 1 FROM information_schema.columns WHERE table_schema='servicedesk' AND table_name='sla_policies' AND column_name='queue_id'`);
    // Cuando MS.7.2 llegue este control se actualiza JUNTO con la siembra de su SLA (es un recordatorio, no un freno).
    ok(slaCol.rows.length === 0, 'el SLA sigue siendo global (MS.7.2 lo vuelve por cola): no se siembra un SLA propio que nadie leería');

    console.log('\n4 — idempotente: no pisa lo que la coordinación ajustó');
    await knex.transaction(async (trx) => {
      await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'plomeria' }).update({ name: 'Plomería (ajustada)', default_priority: 'alta' });
      await trx('servicedesk.queues').where({ id: cola.id }).update({ active: true });
      await seed.up(trx);
      const c = await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'plomeria' }).first();
      const q = await trx('servicedesk.queues').where({ id: cola.id }).first();
      ok(c.name === 'Plomería (ajustada)' && c.default_priority === 'alta', '⭐ re-correr la siembra NO deshace el nombre ni la prioridad que ajustó la coordinación');
      ok(q.active === true, '⭐ ni apaga una cola que la coordinación ya encendió');
      const n = await trx('servicedesk.categories').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(n.n) === 11, 'y no duplica categorías');
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    console.log('\n5 — el down conserva lo que tiene historia');
    await knex.transaction(async (trx) => {
      const usuario = await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
      const cat = await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'plomeria' }).first('id');
      await trx('servicedesk.requests').insert({
        tenant_id: T, folio: 'SRV-2099-77777', queue_id: cola.id, category_id: cat.id, title: 'Smoke MS.7.14', requester_id: usuario.id,
      });
      await seed.down(trx);
      const sigue = await trx('servicedesk.queues').where({ id: cola.id }).first('id');
      ok(!!sigue, '⭐ con un ticket levantado en la cola, el down la CONSERVA (el ticket es registro)');
      await trx('servicedesk.requests').where({ folio: 'SRV-2099-77777' }).del();
      await seed.down(trx);
      const fuera = await trx('servicedesk.queues').where({ id: cola.id }).first('id');
      ok(!fuera, 'CONTROL: sin tickets, el down SÍ la retira');
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    const sigueReal = await knex('servicedesk.queues').where({ tenant_id: T, code: 'mantenimiento' }).first('id');
    ok(!!sigueReal, 'rollback real: la cola de verdad sigue ahí');
  } catch (e) {
    fail++;
    console.log('\n  ✗ EXCEPCIÓN:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
