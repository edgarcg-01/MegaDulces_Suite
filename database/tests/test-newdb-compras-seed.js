/* eslint-disable no-console */
/**
 * `[MS.8.1]` Siembra de la cola «Compras (precios y productos)» (`20261111135132_servicedesk_seed_compras.js`). Smoke
 * DB-direct: TODO corre dentro de transacciones que se REVIERTEN (la base queda como estaba).
 *
 * Qué defiende (cada bloque con su negativa, y cada negativa con su control positivo):
 *   1. Con el responsable (`mario_ventura`): la cola nace ENCENDIDA, con él de coordinador y responsable por omisión, y él
 *      recibe SÓLO los dos permisos de la Mesa, individuales (no a todo su puesto).
 *   2. Las 8 categorías pedidas (exigen sucursal, prioridad `media`) y las 3 preguntas de texto opcionales.
 *   3. NO es confidencial: una cola confidencial sin coordinación queda bloqueada para siempre (lo vivido con Mantenimiento
 *      el 2026-11-10).
 *   4. Idempotente: re-correrla no pisa lo ajustado ni vuelve a encender una cola que la coordinación apagó, y no pisa un
 *      permiso negado a mano.
 *   5. Sin el usuario del responsable: la cola nace APAGADA y sin miembros (encendida y sin nadie, cada ticket caería en una
 *      bandeja que nadie ve).
 *   6. El `down` conserva lo que tiene historia y sólo retira los permisos que puso ESTA migración.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-compras-seed');
const seed = require('../migrations-newdb/20261111135132_servicedesk_seed_compras.js');

const T = '00000000-0000-0000-0000-00000000d01c';
const CATS = ['precio_incorrecto', 'codigo_barras', 'producto_no_encontrado', 'descripcion_producto', 'iva', 'margen', 'ieps', 'otro'];
const PREGUNTAS = ['codigo_barras', 'clave_producto', 'observaciones'];
const NOTA = '[MS.8.1] responsable de la cola Compras de la Mesa de Servicio';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const ROLLBACK = '__ROLLBACK__';
const enReversa = (fn) => knex.transaction(async (trx) => { await fn(trx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });

/** Deja la escena limpia DENTRO de la transacción: sin la cola (si no tiene tickets) y con/sin el usuario del responsable. */
async function escena(trx, { conMario }) {
  await seed.down(trx);
  let mario = await trx('identity.users').where({ tenant_id: T, username: 'mario_ventura' }).first('id');
  if (conMario && !mario) {
    // El puesto real (`auxiliar_compras`) puede no existir en la base de prueba: se toma el de un usuario cualquiera del tenant.
    const { role_name } = await trx('identity.users').where({ tenant_id: T }).whereNotNull('role_name').first('role_name');
    [mario] = await trx('identity.users').insert({ tenant_id: T, username: 'mario_ventura', nombre: 'MARIO VENTURA (prueba)', role_name, status: 'invited' }).returning('id');
  }
  if (!conMario && mario) await trx('identity.users').where({ id: mario.id }).update({ username: 'mario_ventura_fuera_de_prueba' });
  return conMario ? mario.id : null;
}

(async () => {
  try {
    await enReversa(async (trx) => {
      const marioId = await escena(trx, { conMario: true });
      await seed.up(trx);
      const cola = await trx('servicedesk.queues').where({ tenant_id: T, code: 'compras' }).first();

      console.log('\n1 — la cola, con su responsable');
      ok(!!cola, 'existe la cola «compras»');
      ok(cola?.active === true, '⭐ nace ENCENDIDA porque su responsable quedó como coordinador con los dos permisos');
      ok(cola?.default_assignee_id === marioId, '⭐ Mario es el responsable por omisión (lo nuevo le cae asignado)');
      ok(cola?.priority_model === 'impacto' && cola?.asks_zone === false, 'modelo de prioridad «impacto» (como TI) y sin zona');
      const miembros = await trx('servicedesk.queue_members').where({ queue_id: cola.id });
      ok(miembros.length === 1 && miembros[0].user_id === marioId && miembros[0].role === 'coordinador' && miembros[0].active, '⭐ un solo miembro: Mario, coordinador, activo');
      const perms = await trx('identity.user_permissions').where({ tenant_id: T, user_id: marioId }).whereLike('permission_key', 'SERVICIO_%').orderBy('permission_key');
      ok(perms.map((p) => p.permission_key).join(',') === 'SERVICIO_ATENDER,SERVICIO_COORDINAR' && perms.every((p) => p.allow === true), '⭐ Mario recibe SERVICIO_ATENDER y SERVICIO_COORDINAR, individuales');
      const puesto = await trx('identity.role_permissions').where({ role_name: 'auxiliar_compras' }).first().catch(() => null);
      ok(!puesto || (puesto.permissions?.SERVICIO_ATENDER == null && puesto.permissions?.SERVICIO_COORDINAR == null), 'CONTROL: el puesto auxiliar_compras NO recibe nada (sólo Mario)');
      const ti = await trx('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('active');
      ok(ti?.active === true, 'CONTROL: la cola de TI sigue como estaba');

      console.log('\n2 — categorías y preguntas');
      const cats = await trx('servicedesk.categories').where({ queue_id: cola.id }).orderBy('sort_order');
      ok(JSON.stringify(cats.map((c) => c.code)) === JSON.stringify(CATS), `las 8 categorías pedidas, en su orden (hay ${cats.length})`);
      ok(cats.every((c) => c.requires_branch === true && c.default_priority === 'media' && c.active), 'todas exigen sucursal, prioridad «media», activas');
      const preg = await trx('servicedesk.queue_fields').where({ queue_id: cola.id }).orderBy('sort_order');
      ok(JSON.stringify(preg.map((p) => p.code)) === JSON.stringify(PREGUNTAS), 'las 3 preguntas: código de barras, clave del producto, observaciones');
      ok(preg.every((p) => p.type === 'text' && p.required === false && p.active), 'de texto y opcionales');

      console.log('\n3 — no es confidencial');
      ok(cola.confidential === false, '⭐ NO confidencial (una confidencial sin coordinación queda bloqueada: Mantenimiento, 2026-11-10)');

      console.log('\n4 — idempotente');
      await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'iva' }).update({ name: 'IVA (ajustada)' });
      await trx('servicedesk.queues').where({ id: cola.id }).update({ active: false });
      await seed.up(trx);
      const c2 = await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'iva' }).first('name');
      const q2 = await trx('servicedesk.queues').where({ id: cola.id }).first('active');
      ok(c2.name === 'IVA (ajustada)', '⭐ re-correrla NO pisa una categoría ajustada');
      ok(q2.active === false, '⭐ ni vuelve a encender una cola que la coordinación apagó');
      const n = await trx('servicedesk.categories').where({ queue_id: cola.id }).count({ n: '*' }).first();
      const nm = await trx('servicedesk.queue_members').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(n.n) === 8 && Number(nm.n) === 1, 'y no duplica categorías ni miembros');
      await trx('identity.user_permissions').where({ tenant_id: T, user_id: marioId, permission_key: 'SERVICIO_COORDINAR' }).update({ allow: false, nota: 'negado a mano' });
      await seed.up(trx);
      const neg = await trx('identity.user_permissions').where({ tenant_id: T, user_id: marioId, permission_key: 'SERVICIO_COORDINAR' }).first();
      ok(neg.allow === false && neg.nota === 'negado a mano', '⭐ no pisa un permiso negado a mano');

      console.log('\n6 — el down');
      await trx('identity.user_permissions').insert({ tenant_id: T, user_id: marioId, permission_key: 'SERVICIO_LEVANTAR', allow: true, nota: 'dado a mano' }).onConflict(['tenant_id', 'user_id', 'permission_key']).ignore();
      const usuario = await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
      const cat = await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'otro' }).first('id');
      await trx('servicedesk.requests').insert({ tenant_id: T, folio: 'SRV-2099-77778', queue_id: cola.id, category_id: cat.id, title: 'Smoke MS.8.1', requester_id: usuario.id });
      await seed.down(trx);
      ok(!!(await trx('servicedesk.queues').where({ id: cola.id }).first('id')), '⭐ con un ticket levantado, el down CONSERVA la cola');
      await trx('servicedesk.requests').where({ folio: 'SRV-2099-77778' }).del();
      await seed.down(trx);
      ok(!(await trx('servicedesk.queues').where({ id: cola.id }).first('id')), 'CONTROL: sin tickets, el down SÍ la retira');
      const quedan = await trx('identity.user_permissions').where({ tenant_id: T, user_id: marioId }).whereIn('permission_key', ['SERVICIO_ATENDER', 'SERVICIO_LEVANTAR']);
      ok(quedan.length === 1 && quedan[0].permission_key === 'SERVICIO_LEVANTAR', '⭐ retira el permiso que puso la migración y conserva el que se dio a mano');
      ok(!(await trx('identity.user_permissions').where({ nota: NOTA }).first()), 'no queda ningún permiso con la nota de la migración');
    });

    await enReversa(async (trx) => {
      console.log('\n5 — sin el usuario del responsable');
      await escena(trx, { conMario: false });
      await seed.up(trx);
      const cola = await trx('servicedesk.queues').where({ tenant_id: T, code: 'compras' }).first();
      ok(!!cola && cola.active === false && cola.default_assignee_id === null, '⭐ la cola nace APAGADA y sin responsable');
      const nm = await trx('servicedesk.queue_members').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(nm.n) === 0, '⭐ y sin miembros (no se adivina un usuario)');
      const cats = await trx('servicedesk.categories').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(cats.n) === 8, 'CONTROL: las categorías sí se siembran');
    });
  } catch (e) {
    fail++;
    console.log('\n  ✗ EXCEPCIÓN:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
