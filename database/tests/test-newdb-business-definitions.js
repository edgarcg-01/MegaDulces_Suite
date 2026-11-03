/* eslint-disable no-console */
/**
 * `[DP.0.1]` `[DP.0.2]` — Definiciones de negocio contra el esquema REAL (Fase DP).
 *
 *   1. Schema `platform`: las dos tablas existen, RLS activo y FORZADO, política de aislamiento, USAGE.
 *   2. Grants exactos para `app_runtime`: la pregunta sin DELETE (se descarta), la respuesta sin
 *      UPDATE ni DELETE (es registro).
 *   3. Las 17 preguntas de Comisiones RD: sembradas, todas `pendiente`, SIN dueño (D4), y lo que dijo
 *      Lupita como PROPUESTA con su fuente, nunca como respuesta (D2).
 *   4. Cada invariante de la máquina de estados se rompe a propósito UNA vez y se exige el código
 *      exacto (23514 / 23503 / 23505), con su CONTROL POSITIVO: la misma fila sin el defecto SÍ entra.
 *      Sin el control, un rechazo podría venir de una consulta rota y no del CHECK.
 *   5. Aislamiento y permisos REALES con `SET LOCAL ROLE app_runtime` (el dueño de la tabla salta RLS:
 *      sin el cambio de rol este bloque se pondría verde midiendo nada).
 *
 * Todo lo que escribe corre en UNA transacción que se revierte, y se prueba que el rollback fue real.
 * ⛔ No se corre con el `.env` por defecto: apunta a producción. Corre en el job `pruebas-db` del CI.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-business-definitions');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000f9';
const KEY_PRUEBA = 'smoke.dp.prueba';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); }
}
/** Corre `fn` dentro de un SAVEPOINT y devuelve el código SQLSTATE del error (null si no falló). */
async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_dp');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || e.message; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_dp');
  return code;
}

const GRANTS = {
  business_definitions: ['SELECT', 'INSERT', 'UPDATE'],
  business_definition_answers: ['SELECT', 'INSERT'],
};
const TODOS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

(async () => {
  try {
    console.log('\n── 1. Schema, RLS forzado y política de aislamiento');
    for (const t of Object.keys(GRANTS)) {
      const r = await knex.raw(
        `SELECT c.relrowsecurity rls, c.relforcerowsecurity frz,
                EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='platform' AND p.tablename=? AND p.policyname='tenant_isolation') pol
           FROM pg_class c WHERE c.oid = to_regclass(?)`,
        [t, `platform.${t}`],
      );
      const row = r.rows[0];
      ok(!!row && row.rls === true && row.frz === true && row.pol === true,
        `platform.${t}: existe, RLS activo y FORZADO, política tenant_isolation`);
    }
    const usage = await knex.raw(`SELECT has_schema_privilege('app_runtime','platform','USAGE') u`);
    ok(usage.rows[0].u === true, 'app_runtime tiene USAGE del schema (sin él: 42501)');

    console.log('\n── 2. Grants por tabla: lo que cada una necesita, no más');
    for (const [t, esperado] of Object.entries(GRANTS)) {
      const tiene = [];
      for (const p of TODOS) {
        const r = await knex.raw(`SELECT has_table_privilege('app_runtime', ?, ?) v`, [`platform.${t}`, p]);
        if (r.rows[0].v) tiene.push(p);
      }
      ok(JSON.stringify(tiene) === JSON.stringify(esperado),
        `platform.${t}: app_runtime tiene ${tiene.join('+')} (esperado ${esperado.join('+')})`);
    }

    console.log('\n── 3. Las 17 preguntas de Comisiones RD');
    const rd = await knex('platform.business_definitions')
      .where({ tenant_id: T, consumer: 'commercial.commissions' }).whereNull('deleted_at');
    ok(rd.length === 17, `17 preguntas sembradas (hay ${rd.length})`);
    ok(rd.every((d) => d.status === 'pendiente'), 'todas nacen `pendiente`');
    ok(rd.every((d) => d.assigned_to === null), '⭐ todas nacen SIN dueño (D4): quién contesta lo decide Edgar');
    ok(rd.every((d) => d.answered_at === null), 'ninguna nace contestada');
    const conPropuesta = rd.filter((d) => d.suggested_value !== null);
    ok(conPropuesta.length === 3 && conPropuesta.every((d) => /Lupita/.test(d.suggested_source || '')),
      `lo que Lupita dijo entra como PROPUESTA con su fuente (3: motivos, 3 periodos, último viernes) — hay ${conPropuesta.length}`);
    const ventana = rd.find((d) => d.key === 'rd.ausencia.ventana');
    ok(ventana && Number(ventana.suggested_value) === 3 && ventana.value_type === 'number',
      'rd.ausencia.ventana: propuesta 3, tipo número');
    const resp = await knex('platform.business_definition_answers').where({ tenant_id: T })
      .whereIn('definition_id', rd.map((d) => d.id)).count('* as n').first();
    ok(Number(resp.n) === 0, 'cero respuestas sembradas: una propuesta NO es una respuesta (D2)');

    const usuario = await knex('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
    if (!usuario) {
      console.log('  ⚠️  NO MEDIDO: no hay un usuario con qué probar el ciclo de la pregunta');
      fail++;
      return;
    }
    const U = usuario.id;

    await knex.transaction(async (trx) => {
      let n = 0;
      const base = (o = {}) => ({
        tenant_id: T, key: `${KEY_PRUEBA}${++n}`, area: 'plataforma', consumer: 'smoke.dp',
        question: '¿Pregunta de prueba?', value_type: 'number', ...o,
      });
      const ins = (o) => trx('platform.business_definitions').insert(base(o)).returning('*');

      console.log('\n── 4. Invariantes: cada una rota una vez, con su control');
      ok((await codigo(trx, () => ins())) === null, 'CONTROL: una pregunta bien formada SÍ entra');
      ok((await codigo(trx, () => ins({ key: 'SinPunto' }))) === '23514', 'NEGATIVA: una key sin `dominio.nombre` (23514)');
      ok((await codigo(trx, () => ins({ area: 'marketing' }))) === '23514', 'NEGATIVA: un área fuera del catálogo (23514)');
      ok((await codigo(trx, () => ins({ value_type: 'json' }))) === '23514', 'NEGATIVA: un tipo de respuesta desconocido (23514)');
      ok((await codigo(trx, () => ins({ status: 'en_proceso' }))) === '23514', 'NEGATIVA: un estado fuera del vocabulario (23514)');
      ok((await codigo(trx, () => ins({ value_type: 'choice' }))) === '23514', 'NEGATIVA: `choice` sin opciones (23514)');
      ok((await codigo(trx, () => ins({ value_type: 'choice', choices: JSON.stringify([{ value: 'a', label: 'A' }]) }))) === '23514',
        'NEGATIVA: `choice` con UNA sola opción no es una elección (23514)');
      ok((await codigo(trx, () => ins({ value_type: 'choice', choices: JSON.stringify([{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]) }))) === null,
        'CONTROL: `choice` con dos opciones SÍ entra');
      ok((await codigo(trx, () => ins({ choices: JSON.stringify([{ value: 'a' }, { value: 'b' }]) }))) === '23514',
        'NEGATIVA: opciones en una pregunta que no es de elección (23514)');
      ok((await codigo(trx, () => ins({ value_type: 'config_ref' }))) === '23514', 'NEGATIVA: `config_ref` sin pantalla donde configurarla (23514)');
      ok((await codigo(trx, () => ins({ value_type: 'config_ref', config_route: '/comercial/comisiones' }))) === null,
        'CONTROL: `config_ref` con su pantalla SÍ entra');
      ok((await codigo(trx, () => ins({ suggested_value: '3' }))) === '23514', 'NEGATIVA: una propuesta sin fuente no se puede citar (23514)');
      ok((await codigo(trx, () => ins({ suggested_value: '3', suggested_source: 'junta del lunes' }))) === null,
        'CONTROL: una propuesta CON fuente SÍ entra');
      ok((await codigo(trx, () => ins({ assigned_to: U }))) === '23514', 'NEGATIVA: dueño sin fecha de asignación (23514)');
      ok((await codigo(trx, () => ins({ assigned_to: U, assigned_at: trx.fn.now(), assigned_by: U }))) === null,
        'CONTROL: dueño con su fecha SÍ entra');
      ok((await codigo(trx, () => ins({ assigned_to: '00000000-0000-0000-0000-000000000bad', assigned_at: trx.fn.now() }))) === '23503',
        'NEGATIVA: un dueño que no está en el padrón (23503)');
      ok((await codigo(trx, () => ins({ status: 'respondida' }))) === '23514', 'NEGATIVA: `respondida` sin fecha de respuesta (23514)');
      ok((await codigo(trx, () => ins({ status: 'respondida', answered_at: trx.fn.now() }))) === '23514', 'NEGATIVA: `respondida` sin quién contestó (23514)');
      ok((await codigo(trx, () => ins({ answered_at: trx.fn.now(), answered_by: U }))) === '23514', 'NEGATIVA: fecha de respuesta en una `pendiente` (23514)');
      ok((await codigo(trx, () => ins({ status: 'respondida', answered_at: trx.fn.now(), answered_by: U }))) === null,
        'CONTROL: `respondida` con fecha y autor SÍ entra');
      ok((await codigo(trx, () => ins({ status: 'descartada', discarded_at: trx.fn.now() }))) === '23514', 'NEGATIVA: descartar sin motivo (23514)');
      ok((await codigo(trx, () => ins({ status: 'descartada', discarded_at: trx.fn.now(), discard_reason: 'ya no aplica' }))) === null,
        'CONTROL: descartar CON motivo SÍ entra');
      const [d] = await ins();
      ok((await codigo(trx, () => ins({ key: d.key }))) === '23505', 'NEGATIVA: dos preguntas con la misma key en el tenant (23505)');

      const insR = (o = {}) => trx('platform.business_definition_answers').insert({
        tenant_id: T, definition_id: d.id, value: JSON.stringify(3), valid_from: '2026-11-01', note: 'contestada en la prueba',
        answered_by: U, ...o,
      });
      ok((await codigo(trx, () => insR())) === null, 'CONTROL: una respuesta con valor, vigencia, motivo y autor SÍ entra');
      ok((await codigo(trx, () => insR({ note: '   ' }))) === '23514', 'NEGATIVA: una respuesta sin motivo (23514)');
      ok((await codigo(trx, () => insR({ value: 'null' }))) === '23514', 'NEGATIVA: una respuesta con valor null (23514)');
      ok((await codigo(trx, () => insR({ answered_by: null }))) === '23502', 'NEGATIVA: una respuesta sin autor (23502)');
      ok((await codigo(trx, () => insR({ definition_id: '00000000-0000-0000-0000-000000000bad' }))) === '23503',
        'NEGATIVA: una respuesta a una pregunta que no existe (23503)');

      console.log('\n── 5. Aislamiento por tenant y permisos REALES (SET LOCAL ROLE app_runtime)');
      await insR();
      const comoRuntime = async (tenant, fn) => {
        await trx.raw('SET LOCAL ROLE app_runtime');
        await trx.raw(`SET LOCAL app.tenant_id = '${tenant}'`);
        const r = await fn();
        await trx.raw('RESET ROLE');
        return r;
      };
      const rt = (fn) => codigo(trx, () => comoRuntime(T, fn));
      ok((await rt(() => trx('platform.business_definitions').where({ id: d.id }).update({ due_at: trx.fn.now() }))) === null,
        'CONTROL: app_runtime SÍ actualiza una pregunta (asignar, plazo, descartar)');
      ok((await rt(() => trx('platform.business_definitions').where({ id: d.id }).del())) === '42501',
        '⭐ NEGATIVA: app_runtime NO borra una pregunta (42501): se descarta con motivo');
      ok((await rt(() => trx('platform.business_definition_answers').where({ definition_id: d.id }).update({ note: 'otra' }))) === '42501',
        '⭐ NEGATIVA: app_runtime NO edita una respuesta (42501): contestar otra vez agrega una vigencia');
      ok((await rt(() => trx('platform.business_definition_answers').where({ definition_id: d.id }).del())) === '42501',
        '⭐ NEGATIVA: app_runtime NO borra una respuesta (42501)');
      const visto = await codigo(trx, async () => {
        const filas = await comoRuntime(OTRO, () => trx('platform.business_definitions').where({ id: d.id }));
        if (filas.length) throw new Error('VISIBLE');
      });
      ok(visto === null, 'otro tenant NO ve la pregunta (RLS)');
      ok((await codigo(trx, () => comoRuntime(OTRO, () => trx('platform.business_definitions').insert(base({ tenant_id: T })))) ) === '42501',
        'NEGATIVA: otro tenant no puede escribir filas de éste (42501, WITH CHECK)');

      throw new Error('__ROLLBACK__'); // ← cero efecto real
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    const sobra = await knex('platform.business_definitions').where({ tenant_id: T })
      .where('key', 'like', `${KEY_PRUEBA}%`).count('* as n').first();
    ok(Number(sobra.n) === 0, 'rollback real: no quedó ninguna pregunta de prueba');
  } catch (e) {
    fail++;
    console.log('\n  ✗ EXCEPCIÓN:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
