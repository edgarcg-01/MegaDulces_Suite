/* eslint-disable no-console */
/**
 * `[MS.7.3]` Mesa de Servicio — ZONAS (el lugar dentro de la ubicación). Smoke DB-direct con ROLLBACK: cero efecto real.
 *
 *   1. Schema: `zones` con RLS FORZADO + política; `requests.zone_code` y `queues.asks_zone` existen.
 *   2. Siembra: las 5 zonas del plan; Mantenimiento pregunta la zona y TI NO (por valor, no por nombre).
 *   3. Integridad: el código mal formado se rechaza, no se repite por tenant, el ticket sólo admite una zona DEL CATÁLOGO (FK
 *      compuesta) y NULL (sin zona) es válido. Cada negativa trae su control positivo.
 *   4. Permisos reales como `app_runtime`: lee, escribe y edita zonas, pero NO las borra (apagar no borra) y no ve las de otro tenant.
 *
 * ⚠️ «Un gate sin prueba negativa es una intención» (ADR-056).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-zonas');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000f7';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_zn');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || e.message; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_zn');
  return code;
}

(async () => {
  try {
    console.log('\n1 — schema');
    const r = await knex.raw(
      `SELECT c.relrowsecurity rls, c.relforcerowsecurity frz,
              EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='servicedesk' AND p.tablename='zones' AND p.policyname='tenant_isolation') pol
         FROM pg_class c WHERE c.oid = to_regclass('servicedesk.zones')`,
    );
    ok(r.rows[0]?.rls && r.rows[0]?.frz && r.rows[0]?.pol, 'zones: RLS activo, FORZADO y con la política tenant_isolation');
    const cols = (await knex.raw(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='servicedesk' AND ((table_name='requests' AND column_name='zone_code') OR (table_name='queues' AND column_name='asks_zone'))`)).rows;
    ok(cols.length === 2, 'requests.zone_code y queues.asks_zone existen');

    console.log('\n2 — siembra');
    const zonas = await knex('servicedesk.zones').where({ tenant_id: T }).orderBy('sort_order').pluck('code');
    ok(['bodega', 'anden', 'oficina', 'banos', 'exterior'].every((c) => zonas.includes(c)), 'las 5 zonas del plan están sembradas');
    const mto = await knex('servicedesk.queues').where({ tenant_id: T, code: 'mantenimiento' }).first('asks_zone');
    const ti = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('asks_zone');
    if (!mto) console.log('  ⓘ NO MEDIDO: Mantenimiento no está sembrada en este destino');
    else ok(mto.asks_zone === true, '⭐ Mantenimiento pregunta la zona');
    ok(ti?.asks_zone === false, '⛔ TI NO la pregunta: lo de Mantenimiento no se filtró a las demás colas');

    console.log('\n3 — integridad');
    const usuario = await knex('identity.users').where({ tenant_id: T }).whereNull('deleted_at').first('id');
    const cola = await knex('servicedesk.queues').where({ tenant_id: T, code: 'ti' }).first('id');
    const cat = await knex('servicedesk.categories').where({ tenant_id: T, queue_id: cola.id }).first('id');
    if (!usuario || !cat) {
      console.log('  ⚠️  NO MEDIDO: no hay usuario o categoría con qué probar el ticket');
      fail++;
      return;
    }
    await knex.transaction(async (trx) => {
      const zin = (o) => trx('servicedesk.zones').insert({ tenant_id: T, code: 'smoke_z', name: 'Smoke', ...o });
      ok((await codigo(trx, () => zin({ code: 'Mal Formado' }))) === '23514', '⭐ un código con mayúsculas/espacios lo rechaza la base (CHECK)');
      ok((await codigo(trx, () => zin({ code: '1abc' }))) === '23514', 'un código que no empieza con letra → CHECK');
      ok((await codigo(trx, () => zin({ name: '   ' }))) === '23514', 'un nombre vacío → CHECK');
      ok((await codigo(trx, () => zin({}))) === null, 'CONTROL: la misma zona bien formada SÍ entra');
      await zin({});
      ok((await codigo(trx, () => zin({}))) === '23505', '⭐ el código no se repite dentro del tenant');
      ok((await codigo(trx, () => zin({ code: 'bodega' }))) === '23505', 'ni choca con una sembrada');

      let n = 0;
      const tk = (o = {}) => trx('servicedesk.requests').insert({
        tenant_id: T, folio: `SRV-2099-${String(80000 + ++n)}`, queue_id: cola.id, category_id: cat.id, title: 'Smoke MS.7.3', requester_id: usuario.id, ...o,
      });
      ok((await codigo(trx, () => tk({ zone_code: 'no_existe' }))) === '23503', '⭐ un ticket NO admite una zona fuera del catálogo (FK compuesta)');
      ok((await codigo(trx, () => tk({ zone_code: 'bodega' }))) === null, 'CONTROL: una zona del catálogo SÍ entra');
      ok((await codigo(trx, () => tk({ zone_code: null }))) === null, 'y NULL (sin zona) es válido: la zona es opcional');
      await tk({ zone_code: 'bodega' }); // un ticket REAL que la usa (codigo() revierte siempre)
      ok((await codigo(trx, () => trx('servicedesk.zones').where({ tenant_id: T, code: 'bodega' }).update({ code: 'bodega2' }))) === '23503', '⛔ una zona en uso no puede cambiar de código (los tickets ya la guardan)');
      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    console.log('\n4 — permisos reales (app_runtime)');
    await knex.transaction(async (trx) => {
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const veo = await trx('servicedesk.zones').count({ n: '*' }).first();
      ok(Number(veo.n) >= 5, 'el runtime LEE las zonas de su tenant');
      ok((await codigo(trx, () => trx('servicedesk.zones').insert({ tenant_id: T, code: 'rt_z', name: 'RT' }))) === null, 'CONTROL: el runtime SÍ da de alta una zona');
      ok((await codigo(trx, () => trx('servicedesk.zones').where({ code: 'bodega' }).update({ active: false }))) === null, 'y SÍ la apaga');
      ok((await codigo(trx, () => trx('servicedesk.zones').where({ code: 'bodega' }).del())) === '42501', '⛔ pero NO la borra (apagar no borra): sin grant de DELETE');
      ok((await codigo(trx, () => trx('servicedesk.zones').insert({ tenant_id: OTRO, code: 'ajena', name: 'Ajena' }))) !== null, '⛔ ni escribe en el tenant de otro (RLS WITH CHECK)');
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
