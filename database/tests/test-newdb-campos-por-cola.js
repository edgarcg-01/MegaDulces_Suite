/* eslint-disable no-console */
/**
 * `[MS.7.4]` Mesa de Servicio — CAMPOS PROPIOS POR COLA. Smoke DB-direct con ROLLBACK: cero efecto real.
 *
 *   1. Schema: `queue_fields` con RLS FORZADO + política; `requests.extra` existe, es jsonb y los tickets existentes quedan con `{}`.
 *   2. Nada sembrado: ni TI ni Mantenimiento traen campos (la foto sigue siendo un adjunto opcional).
 *   3. Integridad de la definición: código mal formado, tipo desconocido, pregunta vacía/larga, opciones (select 2–20; los demás tipos
 *      no llevan), código repetido por cola (pero sí en otra cola), cola inexistente. Cada negativa con su control positivo.
 *   4. `requests.extra`: sólo un OBJETO (un arreglo o un texto lo rechaza la base); el default es `{}`.
 *   5. Permisos reales como `app_runtime`: lee, crea y edita campos, NO los borra (apagar no borra) y no escribe en otro tenant.
 *
 * ⚠️ «Un gate sin prueba negativa es una intención» (ADR-056).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-campos-por-cola');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000f7';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_cf');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || e.message; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_cf');
  return code;
}

(async () => {
  try {
    console.log('\n1 — schema');
    const r = await knex.raw(
      `SELECT c.relrowsecurity rls, c.relforcerowsecurity frz,
              EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='servicedesk' AND p.tablename='queue_fields' AND p.policyname='tenant_isolation') pol
         FROM pg_class c WHERE c.oid = to_regclass('servicedesk.queue_fields')`,
    );
    ok(r.rows[0]?.rls && r.rows[0]?.frz && r.rows[0]?.pol, 'queue_fields: RLS activo, FORZADO y con la política tenant_isolation');
    const col = (await knex.raw(`SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_schema='servicedesk' AND table_name='requests' AND column_name='extra'`)).rows[0];
    ok(col?.data_type === 'jsonb' && col?.is_nullable === 'NO' && /'\{\}'/.test(col?.column_default ?? ''), 'requests.extra es jsonb NOT NULL con default {}');
    const noObjeto = await knex('servicedesk.requests').whereRaw(`jsonb_typeof(extra) <> 'object'`).count({ n: '*' }).first();
    ok(Number(noObjeto.n) === 0, 'todos los tickets existentes tienen un objeto en extra (los anteriores, {})');

    console.log('\n2 — nada sembrado');
    const sembrados = await knex('servicedesk.queue_fields').where({ tenant_id: T }).whereRaw(`code NOT LIKE 'smoke_%'`).count({ n: '*' }).first();
    ok(Number(sembrados.n) === 0, '⭐ ninguna cola trae campos de fábrica (la foto de Mantenimiento sigue opcional)');

    const cola = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');
    const usuario = await knex('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
    const cat = await knex('servicedesk.categories').where({ tenant_id: T, queue_id: cola.id }).first('id');
    if (!usuario || !cat) {
      console.log('  ⚠️  NO MEDIDO: no hay usuario o categoría con qué probar el ticket');
      fail++;
      return;
    }

    await knex.transaction(async (trx) => {
      const [{ id: otraCola }] = await trx('servicedesk.queues').insert({ tenant_id: T, code: 'smoke_cf_db', name: 'SMOKE campos db', sort_order: 998 }).returning('id');
      const f = (o = {}) => trx('servicedesk.queue_fields').insert({ tenant_id: T, queue_id: cola.id, code: 'smoke_f', label: 'Pregunta', type: 'boolean', ...o });
      const sel = (o = {}) => f({ type: 'select', options: JSON.stringify(['A', 'B']), ...o });

      console.log('\n3 — integridad de la definición');
      ok((await codigo(trx, () => f({ code: 'Mal Formado' }))) === '23514', '⭐ código con mayúsculas/espacios → CHECK');
      ok((await codigo(trx, () => f({ code: '1abc' }))) === '23514', 'código que no empieza con letra → CHECK');
      ok((await codigo(trx, () => f({ type: 'fecha' }))) === '23514', '⭐ un tipo que el código no sabe validar → CHECK');
      ok((await codigo(trx, () => f({ label: '   ' }))) === '23514', 'pregunta vacía → CHECK');
      ok((await codigo(trx, () => f({ label: 'x'.repeat(81) }))) === '23514', 'pregunta de más de 80 → CHECK');
      ok((await codigo(trx, () => f({ queue_id: '00000000-0000-0000-0000-0000000000aa' }))) === '23503', '⭐ una cola inexistente se rechaza (FK compuesta)');
      ok((await codigo(trx, () => f({}))) === null, 'CONTROL: la misma definición bien formada SÍ entra');

      ok((await codigo(trx, () => sel({ options: JSON.stringify(['sola']) }))) === '23514', '⭐ un select con UNA opción → CHECK (2–20)');
      ok((await codigo(trx, () => sel({ options: JSON.stringify(Array.from({ length: 21 }, (_, i) => `o${i}`)) }))) === '23514', 'un select con 21 opciones → CHECK');
      ok((await codigo(trx, () => sel({ options: JSON.stringify('no es lista') }))) === '23514', 'opciones que no son una lista → CHECK');
      ok((await codigo(trx, () => f({ options: JSON.stringify(['sí']) }))) === '23514', '⭐ un booleano con opciones → CHECK (los demás tipos no llevan)');
      ok((await codigo(trx, () => f({ type: 'photo', options: JSON.stringify(['x', 'y']) }))) === '23514', 'una foto con opciones → CHECK');
      ok((await codigo(trx, () => sel({}))) === null, 'CONTROL: un select con 2 opciones SÍ entra');
      ok((await codigo(trx, () => f({ type: 'text' }))) === null && (await codigo(trx, () => f({ type: 'photo' }))) === null, 'CONTROL: texto y foto sin opciones SÍ entran');

      await f({});
      ok((await codigo(trx, () => f({}))) === '23505', '⭐ el código no se repite dentro de la misma cola');
      ok((await codigo(trx, () => f({ queue_id: otraCola }))) === null, 'CONTROL: el mismo código en OTRA cola SÍ entra');

      console.log('\n4 — requests.extra');
      let n = 0;
      const tk = (o = {}) => trx('servicedesk.requests').insert({
        tenant_id: T, folio: `SRV-2099-${String(70000 + ++n)}`, queue_id: cola.id, category_id: cat.id, title: 'Smoke MS.7.4', requester_id: usuario.id, ...o,
      }).returning('*');
      ok((await codigo(trx, () => tk({ extra: JSON.stringify(['a']) }))) === '23514', '⭐ extra que es un ARREGLO → CHECK (sólo un objeto)');
      ok((await codigo(trx, () => tk({ extra: JSON.stringify('texto') }))) === '23514', 'extra que es un texto → CHECK');
      ok((await codigo(trx, () => tk({ extra: JSON.stringify({ smoke_f: true }) }))) === null, 'CONTROL: un objeto SÍ entra');
      const sin = (await tk())[0];
      ok(sin.extra && typeof sin.extra === 'object' && Object.keys(sin.extra).length === 0, 'sin decir nada, el ticket queda con {}');
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    console.log('\n5 — permisos reales (app_runtime)');
    await knex.transaction(async (trx) => {
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const ins = (o = {}) => trx('servicedesk.queue_fields').insert({ tenant_id: T, queue_id: cola.id, code: 'smoke_rt', label: 'RT', type: 'text', ...o });
      ok((await codigo(trx, () => ins())) === null, 'CONTROL: el runtime SÍ da de alta un campo');
      await ins();
      ok((await codigo(trx, () => trx('servicedesk.queue_fields').where({ code: 'smoke_rt' }).update({ active: false }))) === null, 'y SÍ lo apaga');
      ok((await codigo(trx, () => trx('servicedesk.queue_fields').where({ code: 'smoke_rt' }).del())) === '42501', '⛔ pero NO lo borra (apagar no borra): sin grant de DELETE');
      ok((await codigo(trx, () => ins({ tenant_id: OTRO, code: 'ajeno' }))) !== null, '⛔ ni escribe en el tenant de otro (RLS WITH CHECK)');
      const veo = await trx('servicedesk.queue_fields').count({ n: '*' }).first();
      ok(Number(veo.n) >= 1, 'el runtime LEE los campos de su tenant');
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
