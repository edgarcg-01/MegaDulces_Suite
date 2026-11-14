/* eslint-disable no-console */
/**
 * `[MSH.4]` Siembra de la cola confidencial «Recursos Humanos» (`20261112120821_servicedesk_seed_rh.js`). Smoke DB-direct:
 * TODO corre dentro de transacciones que se REVIERTEN (la base queda como estaba).
 *
 * Qué defiende (cada bloque con su negativa, y cada negativa con su control positivo):
 *   1. La cola `rh`: CONFIDENCIAL, sin prioridad ni SLA, mínimo de 5 casos, sin responsable por omisión, ligada al aviso `rh`.
 *   2. ⛔ Nace APAGADA aunque sus dos coordinadoras queden completas (abrir RH espera a Legal), y la migración no siembra
 *      ningún aviso de privacidad (el borrador tiene huecos `[…]`).
 *   3. Lesly y Tania: coordinadoras, con SÓLO los dos permisos de la Mesa, individuales (no a todo su puesto).
 *   4. Las 10 categorías de §3.3, sin sucursal.
 *   5. La base hace cumplir la confidencialidad sobre ESTA cola (matriz caso 12, en la base): un ticket nace confidencial y no
 *      se puede mover a TI ni quitarle la marca.
 *   6. Idempotente y respetuosa: no pisa lo ajustado, no enciende, no pisa un permiso negado a mano, y no se monta sobre una
 *      cola `rh` que alguien ya creó NO confidencial.
 *   7. Sin una de las usuarias: la otra queda; no se adivina un usuario.
 *   8. El `down` conserva lo que tiene historia y sólo retira los permisos que puso ESTA migración.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-rh-seed');
const seed = require('../migrations-newdb/20261112120821_servicedesk_seed_rh.js');

const T = '00000000-0000-0000-0000-00000000d01c';
const CATS = ['nomina', 'vacaciones_permisos', 'incapacidades', 'altas_bajas', 'constancias_documentos', 'credenciales_uniformes', 'capacitacion', 'conflicto_laboral', 'prestaciones_prestamos', 'datos_personales_expediente'];
const NOTA = '[MSH.4] coordinadora de la cola confidencial de RH de la Mesa de Servicio';
const USUARIAS = ['lesly_berber', 'tania_solorio'];

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const ROLLBACK = '__ROLLBACK__';
const enReversa = (fn) => knex.transaction(async (trx) => { await fn(trx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
/** ¿La sentencia la rechaza la base? (con SAVEPOINT, para que la transacción siga viva). */
const rechaza = async (trx, fn) => {
  await trx.raw('SAVEPOINT rh_neg');
  try { await fn(); await trx.raw('RELEASE SAVEPOINT rh_neg'); return false; }
  catch { await trx.raw('ROLLBACK TO SAVEPOINT rh_neg'); return true; }
};

/** Escena limpia DENTRO de la transacción: sin la cola y con las usuarias pedidas (las demás, renombradas fuera del alcance). */
async function escena(trx, conUsuarias) {
  await seed.down(trx);
  const ids = {};
  const { role_name } = await trx('identity.users').where({ tenant_id: T }).whereNotNull('role_name').first('role_name');
  for (const username of USUARIAS) {
    let u = await trx('identity.users').where({ tenant_id: T, username }).first('id');
    if (conUsuarias.includes(username)) {
      // Los puestos reales pueden no existir en la base de prueba: se usa el de un usuario cualquiera del tenant.
      if (!u) [u] = await trx('identity.users').insert({ tenant_id: T, username, nombre: `${username} (prueba)`, role_name, status: 'invited' }).returning('id');
      ids[username] = u.id;
    } else if (u) {
      await trx('identity.users').where({ id: u.id }).update({ username: `${username}_fuera_de_prueba` });
    }
  }
  return ids;
}

(async () => {
  try {
    await enReversa(async (trx) => {
      const ids = await escena(trx, USUARIAS);
      const avisosAntes = await trx('servicedesk.privacy_notices').count({ n: '*' }).first();
      await seed.up(trx);
      const cola = await trx('servicedesk.queues').where({ tenant_id: T, code: 'rh' }).first();

      console.log('\n1 — la cola');
      ok(!!cola, 'existe la cola «rh»');
      ok(cola?.confidential === true, '⭐ CONFIDENCIAL (R1: la marca vive en la cola)');
      ok(cola?.uses_priority === false && cola?.sla_enabled === false, '⭐ sin prioridad ni SLA (R5: «—», nunca 0)');
      ok(cola?.report_min_cases === 5, 'mínimo de 5 casos en reportes (R4)');
      ok(cola?.default_assignee_id === null, 'sin responsable por omisión (R6: lo ven las dos)');
      ok(cola?.privacy_notice_code === 'rh', 'ligada al aviso de privacidad «rh» (PRV.2: sin aviso vigente, 409)');
      const dept = await trx('identity.departments').where({ tenant_id: T, code: 'rh' }).whereNull('deleted_at').first('code');
      ok(cola?.department_code === (dept ? 'rh' : null), `departamento «rh» si existe en la base (${dept ? 'existe' : 'no existe'})`);

      console.log('\n2 — nace APAGADA y sin aviso sembrado');
      ok(cola?.active === false, '⭐⛔ nace APAGADA aunque sus dos coordinadoras quedaron completas (abrir RH espera a Legal)');
      const avisosDespues = await trx('servicedesk.privacy_notices').count({ n: '*' }).first();
      ok(Number(avisosDespues.n) === Number(avisosAntes.n), '⭐ no siembra ningún aviso de privacidad (el borrador tiene huecos)');

      console.log('\n3 — las coordinadoras');
      const miembros = await trx('servicedesk.queue_members').where({ queue_id: cola.id }).orderBy('user_id');
      const esperados = USUARIAS.map((u) => ids[u]).sort();
      ok(JSON.stringify(miembros.map((m) => m.user_id).sort()) === JSON.stringify(esperados), '⭐ dos miembros: Lesly y Tania');
      ok(miembros.every((m) => m.role === 'coordinador' && m.active), 'las dos coordinadoras, activas');
      for (const u of USUARIAS) {
        const perms = await trx('identity.user_permissions').where({ tenant_id: T, user_id: ids[u] }).whereLike('permission_key', 'SERVICIO_%').orderBy('permission_key');
        ok(perms.map((p) => p.permission_key).join(',') === 'SERVICIO_ATENDER,SERVICIO_COORDINAR' && perms.every((p) => p.allow === true && p.nota === NOTA), `⭐ ${u}: SERVICIO_ATENDER y SERVICIO_COORDINAR, individuales`);
      }
      for (const puesto of ['reclutamiento_onboarding', 'auxiliar_rh']) {
        const rp = await trx('identity.role_permissions').where({ role_name: puesto }).first().catch(() => null);
        ok(!rp || (rp.permissions?.SERVICIO_ATENDER == null && rp.permissions?.SERVICIO_COORDINAR == null), `CONTROL: el puesto ${puesto} NO recibe nada`);
      }
      const otras = await trx('servicedesk.queues').where({ tenant_id: T }).whereIn('code', ['ti', 'mantenimiento', 'compras']).select('code', 'confidential');
      ok(otras.every((q) => q.confidential === false), 'CONTROL: TI, Mantenimiento y Compras siguen NO confidenciales');

      console.log('\n4 — categorías');
      const cats = await trx('servicedesk.categories').where({ queue_id: cola.id }).orderBy('sort_order');
      ok(JSON.stringify(cats.map((c) => c.code)) === JSON.stringify(CATS), `las 10 categorías de §3.3, en su orden (hay ${cats.length})`);
      ok(cats.every((c) => c.requires_branch === false && c.default_priority === 'media' && c.active), 'ninguna exige sucursal; prioridad interna neutra; activas');

      console.log('\n5 — la base hace cumplir la confidencialidad sobre esta cola');
      const solicitante = await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
      const cat = cats.find((c) => c.code === 'nomina');
      const [tk] = await trx('servicedesk.requests').insert({ tenant_id: T, folio: 'SRV-2099-88881', queue_id: cola.id, category_id: cat.id, title: 'Smoke MSH.4', requester_id: solicitante.id, confidential: false }).returning(['id', 'confidential']);
      ok(tk.confidential === true, '⭐ un ticket en RH nace confidencial aunque el cliente mande «false» (trigger de MSH.1)');
      const ti = await trx('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');
      ok(await rechaza(trx, () => trx('servicedesk.requests').where({ id: tk.id }).update({ queue_id: ti.id })), '⭐ NEGATIVA: no se puede mover a TI (R3)');
      ok(await rechaza(trx, () => trx('servicedesk.requests').where({ id: tk.id }).update({ confidential: false })), '⭐ NEGATIVA: no se le puede quitar la marca');
      ok(await rechaza(trx, () => trx('servicedesk.queues').where({ id: cola.id }).update({ confidential: false })), '⭐ NEGATIVA: con un ticket, la cola ya no puede dejar de ser confidencial');
      ok(!(await rechaza(trx, () => trx('servicedesk.requests').where({ id: tk.id }).update({ title: 'Smoke MSH.4 (editado)' }))), 'CONTROL: un cambio normal al ticket sí pasa');
      await trx('servicedesk.requests').where({ id: tk.id }).del();

      console.log('\n6 — idempotente');
      await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'nomina' }).update({ name: 'Nómina (ajustada)' });
      await seed.up(trx);
      ok((await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'nomina' }).first('name')).name === 'Nómina (ajustada)', '⭐ re-correrla NO pisa una categoría ajustada');
      ok((await trx('servicedesk.queues').where({ id: cola.id }).first('active')).active === false, '⭐ y sigue APAGADA');
      const n = await trx('servicedesk.categories').where({ queue_id: cola.id }).count({ n: '*' }).first();
      const nm = await trx('servicedesk.queue_members').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(n.n) === 10 && Number(nm.n) === 2, 'no duplica categorías ni coordinadoras');
      await trx('identity.user_permissions').where({ tenant_id: T, user_id: ids.tania_solorio, permission_key: 'SERVICIO_COORDINAR' }).update({ allow: false, nota: 'negado a mano' });
      await seed.up(trx);
      const neg = await trx('identity.user_permissions').where({ tenant_id: T, user_id: ids.tania_solorio, permission_key: 'SERVICIO_COORDINAR' }).first();
      ok(neg.allow === false && neg.nota === 'negado a mano', '⭐ no pisa un permiso negado a mano');

      console.log('\n8 — el down');
      await trx('identity.user_permissions').insert({ tenant_id: T, user_id: ids.lesly_berber, permission_key: 'SERVICIO_REPORTAR', allow: true, nota: 'dado a mano' }).onConflict(['tenant_id', 'user_id', 'permission_key']).ignore();
      await trx('servicedesk.requests').insert({ tenant_id: T, folio: 'SRV-2099-88882', queue_id: cola.id, category_id: cat.id, title: 'Smoke MSH.4 down', requester_id: solicitante.id });
      await seed.down(trx);
      ok(!!(await trx('servicedesk.queues').where({ id: cola.id }).first('id')), '⭐ con un ticket levantado, el down CONSERVA la cola');
      await trx('servicedesk.requests').where({ folio: 'SRV-2099-88882' }).del();
      await seed.down(trx);
      ok(!(await trx('servicedesk.queues').where({ id: cola.id }).first('id')), 'CONTROL: sin tickets, el down SÍ la retira');
      const quedan = await trx('identity.user_permissions').where({ tenant_id: T, user_id: ids.lesly_berber }).whereIn('permission_key', ['SERVICIO_ATENDER', 'SERVICIO_REPORTAR']);
      ok(quedan.length === 1 && quedan[0].permission_key === 'SERVICIO_REPORTAR', '⭐ retira el permiso que puso la migración y conserva el que se dio a mano');
      ok(!(await trx('identity.user_permissions').where({ nota: NOTA }).first()), 'no queda ningún permiso con la nota de la migración');
    });

    await enReversa(async (trx) => {
      console.log('\n6b — no se monta sobre una cola «rh» que alguien creó NO confidencial');
      await escena(trx, USUARIAS);
      await trx('servicedesk.queues').insert({ tenant_id: T, code: 'rh', name: 'RH a mano', confidential: false, active: false });
      await seed.up(trx);
      const cola = await trx('servicedesk.queues').where({ tenant_id: T, code: 'rh' }).first();
      ok(cola.confidential === false && cola.name === 'RH a mano', 'la cola existente queda como estaba');
      const nc = await trx('servicedesk.categories').where({ queue_id: cola.id }).count({ n: '*' }).first();
      const nm = await trx('servicedesk.queue_members').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(nc.n) === 0 && Number(nm.n) === 0, '⭐ sin categorías ni coordinadoras de RH colgadas encima');
      ok(!(await trx('identity.user_permissions').where({ nota: NOTA }).first()), '⭐ y sin repartir permisos');
    });

    await enReversa(async (trx) => {
      console.log('\n7 — sin una de las usuarias');
      const ids = await escena(trx, ['lesly_berber']);
      await seed.up(trx);
      const cola = await trx('servicedesk.queues').where({ tenant_id: T, code: 'rh' }).first();
      const miembros = await trx('servicedesk.queue_members').where({ queue_id: cola.id });
      ok(miembros.length === 1 && miembros[0].user_id === ids.lesly_berber, '⭐ queda sólo la que existe (no se adivina un usuario)');
      ok(cola.active === false, 'y la cola, apagada');
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
