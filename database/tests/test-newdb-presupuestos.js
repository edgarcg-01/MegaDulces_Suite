/* eslint-disable no-console */
/**
 * `[MSP.0.1]` + `[MSP.0.2]` Esquema y siembra de la cola «Presupuestos y Requerimientos» de la Mesa de Servicio. Smoke DB-direct:
 * TODO corre dentro de transacciones que se REVIERTEN (la base queda como estaba). La migración de esquema se aplica DENTRO de la
 * transacción (el DDL de Postgres es transaccional), así que no hace falta haberla corrido antes.
 *
 * Qué defiende (cada negativa con su control positivo):
 *   A. Esquema: las columnas nuevas; la base rechaza una lista vacía de puestos, una cola que se manda órdenes a sí misma, un
 *      dictamen incompleto o con un valor inventado, una solicitud que es su propio padre y un padre inexistente; acepta el motivo
 *      de espera `orden_servicio`. Idempotente.
 *   B. Siembra: la cola APAGADA, sin prioridad ni SLA, con los 3 puestos de D1, descripción y dictamen obligatorios, órdenes a
 *      Mantenimiento y TI; 3 categorías con sucursal; los 2 campos obligatorios; Ernesto coordinador con sus 2 permisos
 *      individuales. Idempotente, no pisa ajustes ni un permiso negado; no se monta sobre una `presupuestos` sin dictamen.
 *   C. Los `down`: conservan lo que tiene historia (tickets, dictámenes, órdenes) y retiran sólo lo propio.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-presupuestos');
const esquema = require('../migrations-newdb/20261118132504_servicedesk_presupuestos_esquema.js');
const seed = require('../migrations-newdb/20261118132506_servicedesk_seed_presupuestos.js');

const T = '00000000-0000-0000-0000-00000000d01c';
const NOTA = '[MSP.0.2] coordinación de la cola de Presupuestos y Requerimientos de la Mesa de Servicio';
const CATS = ['gastos_operativos', 'compra_activos', 'otros'];

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const ROLLBACK = '__ROLLBACK__';
const enReversa = (fn) => knex.transaction(async (trx) => { await fn(trx); throw new Error(ROLLBACK); }).catch((e) => { if (e.message !== ROLLBACK) throw e; });
const rechaza = async (trx, fn) => {
  await trx.raw('SAVEPOINT msp_neg');
  try { await fn(); await trx.raw('RELEASE SAVEPOINT msp_neg'); return false; }
  catch { await trx.raw('ROLLBACK TO SAVEPOINT msp_neg'); return true; }
};
/** Rechazada POR esa restricción (el nombre aparece en el error): una negativa que falla por otra causa no prueba nada. */
const rechazaPor = async (trx, restriccion, fn) => {
  await trx.raw('SAVEPOINT msp_neg');
  try { await fn(); await trx.raw('RELEASE SAVEPOINT msp_neg'); return false; }
  catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT msp_neg'); if (!String(e.message).includes(restriccion)) console.log('    (rechazo por otra causa:', e.message.slice(0, 160) + ')'); return String(e.message).includes(restriccion); }
};
const columnas = async (trx, tabla) => (await trx('information_schema.columns').where({ table_schema: 'servicedesk', table_name: tabla }).pluck('column_name'));

/** Escena limpia DENTRO de la transacción: esquema aplicado, sin la cola, y Ernesto presente (o no). */
async function escena(trx, conErnesto) {
  await esquema.up(trx);
  await seed.down(trx);
  let u = await trx('identity.users').where({ tenant_id: T, username: 'ernesto_zarate' }).first('id');
  if (conErnesto) {
    if (!u) {
      const { role_name } = await trx('identity.users').where({ tenant_id: T }).whereNotNull('role_name').first('role_name');
      [u] = await trx('identity.users').insert({ tenant_id: T, username: 'ernesto_zarate', nombre: 'Ernesto (prueba)', role_name, status: 'invited' }).returning('id');
    }
    return u.id;
  }
  if (u) await trx('identity.users').where({ id: u.id }).update({ username: 'ernesto_zarate_fuera_de_prueba' });
  return null;
}

(async () => {
  try {
    await enReversa(async (trx) => {
      console.log('\nA — esquema');
      await esquema.up(trx);
      await esquema.up(trx); // idempotente
      const cq = await columnas(trx, 'queues');
      const cr = await columnas(trx, 'requests');
      ok(['requester_positions', 'requires_description', 'requires_decision', 'work_order_queue_codes'].every((c) => cq.includes(c)), 'queues: requester_positions, requires_description, requires_decision, work_order_queue_codes');
      ok(['decision', 'decision_note', 'decided_by', 'decided_at', 'parent_request_id'].every((c) => cr.includes(c)), 'requests: decision, decision_note, decided_by, decided_at, parent_request_id');
      const ti = await trx('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id', 'requires_description', 'requires_decision', 'requester_positions', 'work_order_queue_codes');
      ok(ti.requires_description === false && ti.requires_decision === false && ti.requester_positions === null && ti.work_order_queue_codes === null, '⭐ CONTROL: las colas existentes quedan como siempre (TI: cualquiera levanta, sin dictamen, sin órdenes)');

      ok(await rechazaPor(trx, 'queues_requester_positions_ck', () => trx.raw(`UPDATE servicedesk.queues SET requester_positions = '{}' WHERE id = ?`, [ti.id])), '⭐ NEGATIVA: una lista VACÍA de puestos (sería «nadie») se rechaza');
      ok(await rechazaPor(trx, 'queues_work_order_codes_ck', () => trx.raw(`UPDATE servicedesk.queues SET work_order_queue_codes = ARRAY['ti'] WHERE id = ?`, [ti.id])), '⭐ NEGATIVA: una cola no se manda órdenes a sí misma');
      ok(!(await rechaza(trx, () => trx.raw(`UPDATE servicedesk.queues SET requester_positions = ARRAY['encargado_sucursal'], work_order_queue_codes = ARRAY['mantenimiento'] WHERE id = ?`, [ti.id]))), 'CONTROL: una lista con valores sí pasa');

      const quien = await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
      const cat = await trx('servicedesk.categories').where({ tenant_id: T, queue_id: ti.id }).first('id');
      const [tk] = await trx('servicedesk.requests').insert({ tenant_id: T, folio: 'SRV-2099-77771', queue_id: ti.id, category_id: cat.id, title: 'Smoke MSP esquema', requester_id: quien.id }).returning('id');
      ok(await rechazaPor(trx, 'requests_decision_complete_ck', () => trx('servicedesk.requests').where({ id: tk.id }).update({ decision: 'autorizado' })), '⭐ NEGATIVA: un dictamen sin quién, cuándo ni motivo se rechaza');
      ok(await rechazaPor(trx, 'requests_decision_ck', () => trx('servicedesk.requests').where({ id: tk.id }).update({ decision: 'quizas', decision_note: 'x', decided_by: quien.id, decided_at: trx.fn.now() })), '⭐ NEGATIVA: un dictamen con un valor inventado se rechaza');
      ok(await rechazaPor(trx, 'requests_decision_note_ck', () => trx('servicedesk.requests').where({ id: tk.id }).update({ decision: 'autorizado', decision_note: '   ', decided_by: quien.id, decided_at: trx.fn.now() })), '⭐ NEGATIVA: un motivo en blanco se rechaza');
      ok(!(await rechaza(trx, () => trx('servicedesk.requests').where({ id: tk.id }).update({ decision: 'no_autorizado', decision_note: 'Sin presupuesto este mes', decided_by: quien.id, decided_at: trx.fn.now() }))), 'CONTROL: un dictamen completo sí pasa');
      ok(await rechazaPor(trx, 'requests_parent_not_self_ck', () => trx('servicedesk.requests').where({ id: tk.id }).update({ parent_request_id: tk.id })), '⭐ NEGATIVA: una solicitud no es su propio padre');
      ok(await rechazaPor(trx, 'requests_parent_fk', () => trx('servicedesk.requests').where({ id: tk.id }).update({ parent_request_id: '00000000-0000-0000-0000-000000000099' })), '⭐ NEGATIVA: un padre que no existe se rechaza (FK)');
      const [hija] = await trx('servicedesk.requests').insert({ tenant_id: T, folio: 'SRV-2099-77772', queue_id: ti.id, category_id: cat.id, title: 'Smoke MSP hija', requester_id: quien.id, parent_request_id: tk.id }).returning('id');
      ok(!!hija?.id, 'CONTROL: una hija con un padre real sí pasa');
      ok(await rechazaPor(trx, 'requests_pause_reason_ck', () => trx('servicedesk.requests').where({ id: tk.id }).update({ status: 'en_espera', paused_at: trx.fn.now(), pause_reason: 'inventado' })), 'NEGATIVA: un motivo de espera inventado se sigue rechazando');
      ok(!(await rechaza(trx, () => trx('servicedesk.requests').where({ id: tk.id }).update({ status: 'en_espera', paused_at: trx.fn.now(), pause_reason: 'orden_servicio' }))), '⭐ el motivo de espera «orden_servicio» se acepta');

      console.log('\nC1 — el down del esquema conserva lo que ya tiene datos');
      await esquema.down(trx);
      const cr2 = await columnas(trx, 'requests');
      ok(cr2.includes('decision') && cr2.includes('parent_request_id'), '⭐ con un dictamen y una orden registrados, el down CONSERVA sus columnas');
    });

    await enReversa(async (trx) => {
      console.log('\nC2 — el down del esquema sin datos lo retira todo');
      await esquema.up(trx);
      await esquema.down(trx);
      const cq = await columnas(trx, 'queues');
      const cr = await columnas(trx, 'requests');
      ok(!cq.includes('requires_decision') && !cr.includes('decision') && !cr.includes('parent_request_id'), 'CONTROL: sin datos, el down retira columnas y restricciones');
      ok(await rechazaPor(trx, 'requests_pause_reason_ck', async () => {
        const q = await trx('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');
        const c = await trx('servicedesk.categories').where({ queue_id: q.id }).first('id');
        const u = await trx('identity.users').where({ tenant_id: T }).first('id');
        await trx('servicedesk.requests').insert({ tenant_id: T, folio: 'SRV-2099-77773', queue_id: q.id, category_id: c.id, title: 'x', requester_id: u.id, status: 'en_espera', paused_at: trx.fn.now(), pause_reason: 'orden_servicio' });
      }), 'y el motivo «orden_servicio» vuelve a rechazarse');
    });

    await enReversa(async (trx) => {
      console.log('\nB — la siembra');
      const ernesto = await escena(trx, true);
      await seed.up(trx);
      const cola = await trx('servicedesk.queues').where({ tenant_id: T, code: 'presupuestos' }).first();
      ok(!!cola, 'existe la cola «presupuestos»');
      ok(cola?.name === 'Presupuestos y Requerimientos', 'se llama «Presupuestos y Requerimientos»');
      ok(cola?.active === false, '⭐⛔ nace APAGADA (se enciende después de desplegar el código que hace cumplir las reglas)');
      ok(cola?.confidential === false, 'NO es confidencial');
      ok(cola?.uses_priority === false && cola?.sla_enabled === false, '⭐ sin prioridad ni SLA (nadie fijó el plazo: «—», nunca un número inventado)');
      ok(JSON.stringify(cola?.requester_positions) === JSON.stringify(['encargado_sucursal', 'auxiliar_encargado', 'jefe_zona']), '⭐ levantan SÓLO encargado_sucursal, auxiliar_encargado y jefe_zona (D1)');
      ok(cola?.requires_description === true && cola?.requires_decision === true, '⭐ exige descripción y dictamen (D2)');
      ok(JSON.stringify(cola?.work_order_queue_codes) === JSON.stringify(['mantenimiento', 'ti']), '⭐ manda órdenes de servicio a Mantenimiento y TI (D3)');
      const dept = await trx('identity.departments').where({ tenant_id: T, code: 'finanzas' }).whereNull('deleted_at').first('code');
      ok(cola?.department_code === (dept ? 'finanzas' : null), `departamento «finanzas» si existe en la base (${dept ? 'existe' : 'no existe'})`);
      ok(cola?.default_assignee_id === null, 'sin responsable por omisión');

      const cats = await trx('servicedesk.categories').where({ queue_id: cola.id }).orderBy('sort_order');
      ok(JSON.stringify(cats.map((c) => c.code)) === JSON.stringify(CATS), `las 3 categorías, en su orden (hay ${cats.length})`);
      ok(cats.every((c) => c.requires_branch === true && c.active), '⭐ todas exigen sucursal (D6) y están activas');
      const campos = await trx('servicedesk.queue_fields').where({ queue_id: cola.id }).orderBy('sort_order');
      ok(campos.length === 2 && campos[0].code === 'observaciones' && campos[0].type === 'text' && campos[0].required === true, '⭐ «Observaciones»: texto OBLIGATORIO');
      ok(campos[1]?.code === 'evidencia' && campos[1]?.type === 'photo' && campos[1]?.required === true, '⭐ «Evidencia»: adjunto OBLIGATORIO');

      const miembros = await trx('servicedesk.queue_members').where({ queue_id: cola.id });
      ok(miembros.length === 1 && miembros[0].user_id === ernesto && miembros[0].role === 'coordinador' && miembros[0].active, '⭐ Ernesto, único miembro, coordinador');
      const perms = await trx('identity.user_permissions').where({ tenant_id: T, user_id: ernesto }).whereLike('permission_key', 'SERVICIO_%').orderBy('permission_key');
      ok(perms.map((p) => p.permission_key).join(',') === 'SERVICIO_ATENDER,SERVICIO_COORDINAR' && perms.every((p) => p.allow === true && p.nota === NOTA), '⭐ SERVICIO_ATENDER y SERVICIO_COORDINAR, individuales');
      const rp = await trx('identity.role_permissions').where({ role_name: 'presupuestos_compras_corp' }).first().catch(() => null);
      ok(!rp || (rp.permissions?.SERVICIO_ATENDER == null && rp.permissions?.SERVICIO_COORDINAR == null), 'CONTROL: su puesto NO recibe nada');

      console.log('\nB2 — idempotente y respetuosa');
      await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'otros' }).update({ name: 'Otros (ajustada)' });
      await trx('identity.user_permissions').where({ tenant_id: T, user_id: ernesto, permission_key: 'SERVICIO_COORDINAR' }).update({ allow: false, nota: 'negado a mano' });
      await seed.up(trx);
      ok((await trx('servicedesk.categories').where({ queue_id: cola.id, code: 'otros' }).first('name')).name === 'Otros (ajustada)', '⭐ re-correrla NO pisa una categoría ajustada');
      ok((await trx('servicedesk.queues').where({ id: cola.id }).first('active')).active === false, '⭐ y sigue APAGADA');
      const n = await trx('servicedesk.categories').where({ queue_id: cola.id }).count({ n: '*' }).first();
      const nf = await trx('servicedesk.queue_fields').where({ queue_id: cola.id }).count({ n: '*' }).first();
      const nm = await trx('servicedesk.queue_members').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(n.n) === 3 && Number(nf.n) === 2 && Number(nm.n) === 1, 'no duplica categorías, campos ni miembros');
      const neg = await trx('identity.user_permissions').where({ tenant_id: T, user_id: ernesto, permission_key: 'SERVICIO_COORDINAR' }).first();
      ok(neg.allow === false && neg.nota === 'negado a mano', '⭐ no pisa un permiso negado a mano');

      console.log('\nC3 — el down de la siembra');
      const solicitante = await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
      await trx('servicedesk.requests').insert({ tenant_id: T, folio: 'SRV-2099-77774', queue_id: cola.id, category_id: cats[0].id, title: 'Smoke MSP down', requester_id: solicitante.id });
      await seed.down(trx);
      ok(!!(await trx('servicedesk.queues').where({ id: cola.id }).first('id')), '⭐ con un ticket levantado, el down CONSERVA la cola');
      await trx('servicedesk.requests').where({ folio: 'SRV-2099-77774' }).del();
      await trx('identity.user_permissions').insert({ tenant_id: T, user_id: ernesto, permission_key: 'SERVICIO_REPORTAR', allow: true, nota: 'dado a mano' }).onConflict(['tenant_id', 'user_id', 'permission_key']).ignore();
      await seed.down(trx);
      ok(!(await trx('servicedesk.queues').where({ id: cola.id }).first('id')), 'CONTROL: sin tickets, el down SÍ la retira (con categorías, campos y miembros)');
      ok(!(await trx('identity.user_permissions').where({ nota: NOTA }).first()), '⭐ retira los permisos con su nota');
      ok(!!(await trx('identity.user_permissions').where({ tenant_id: T, user_id: ernesto, permission_key: 'SERVICIO_REPORTAR' }).first()), 'CONTROL: y conserva el que se dio a mano');
    });

    await enReversa(async (trx) => {
      console.log('\nB3 — no se monta sobre una cola «presupuestos» que alguien creó sin dictamen');
      await escena(trx, true);
      await trx('servicedesk.queues').insert({ tenant_id: T, code: 'presupuestos', name: 'Presupuestos a mano', active: false });
      await seed.up(trx);
      const cola = await trx('servicedesk.queues').where({ tenant_id: T, code: 'presupuestos' }).first();
      ok(cola.name === 'Presupuestos a mano' && cola.requires_decision === false && cola.requester_positions === null, 'la cola existente queda como estaba');
      const nc = await trx('servicedesk.categories').where({ queue_id: cola.id }).count({ n: '*' }).first();
      const nm = await trx('servicedesk.queue_members').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(nc.n) === 0 && Number(nm.n) === 0, '⭐ sin categorías ni miembros colgados encima');
      ok(!(await trx('identity.user_permissions').where({ nota: NOTA }).first()), '⭐ y sin repartir permisos');
    });

    await enReversa(async (trx) => {
      console.log('\nB4 — sin Ernesto en la base');
      await escena(trx, false);
      await seed.up(trx);
      const cola = await trx('servicedesk.queues').where({ tenant_id: T, code: 'presupuestos' }).first();
      const nm = await trx('servicedesk.queue_members').where({ queue_id: cola.id }).count({ n: '*' }).first();
      ok(Number(nm.n) === 0 && cola.active === false, '⭐ la cola queda apagada y sin miembros (no se adivina un usuario)');
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
