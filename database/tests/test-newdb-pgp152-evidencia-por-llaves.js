#!/usr/bin/env node
'use strict';
/**
 * [PGP.152] La evidencia por llaves — contra base real (en el CI, después de `migrate:latest`), todo dentro de una
 * transacción que se revierte al final (cero efecto). Verifica:
 *   1. existe `analytics.payable_evidence(text[])` y la vista `v_payable_evidence` lee de ella;
 *   2. la función con NULL entrega lo mismo que la vista (conteo y huella), y con una llave que no existe, nada;
 *   3. el servicio REAL (`listEvidenceByRefs`, ts-node) responde por la función sin error;
 *   4. ⛔ `down()` regresa la vista a su cuerpo completo y borra la función; `up()` la vuelve a crear igual;
 *   5. ⛔ la transformación se NIEGA si la vista cambió (el ancla no está).
 */
const path = require('path');
const crypto = require('crypto');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp152-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let Servicio;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ PaymentCalendarService: Servicio } = require(path.join(__dirname, '../../libs/finance/src/lib/payment-calendar/payment-calendar.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}
const M = require(path.join(__dirname, '../migrations-newdb/20261118144337_pgp152_evidencia_por_llaves.js'));

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp152-evidencia-por-llaves');

(async () => {
  console.log('\n[PGP.152] La evidencia por llaves — rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      const hayFn = async () => (await trx.raw(`SELECT to_regprocedure('analytics.payable_evidence(text[])') IS NOT NULL AS h`)).rows[0].h;
      const def = async () => (await trx.raw(`SELECT pg_get_viewdef('analytics.v_payable_evidence'::regclass, true) AS d`)).rows[0].d;
      if (!(await hayFn())) {
        console.log('  ·  NO MEDIDO — la migración 20261118144337 no está aplicada en esta base');
        throw ROLLBACK;
      }
      ok(/payable_evidence\(NULL::text\[\]\)/.test(await def()), '1. la vista v_payable_evidence lee de analytics.payable_evidence(NULL)');

      const huella = (rows) => crypto.createHash('sha1').update(rows.map((r) => JSON.stringify(r)).sort().join('\n')).digest('hex');
      const vista = (await trx.raw('SELECT * FROM analytics.v_payable_evidence')).rows;
      const fnTodo = (await trx.raw('SELECT * FROM analytics.payable_evidence(NULL::text[])')).rows;
      ok(vista.length === fnTodo.length && huella(vista) === huella(fnTodo), `2. la función con NULL = la vista (${vista.length} filas, misma huella)`);
      const nada = (await trx.raw(`SELECT * FROM analytics.payable_evidence(ARRAY['ZZ|0|0|NO-EXISTE'])`)).rows;
      ok(nada.length === 0, '2. con una llave que no existe, nada');

      const s = Object.create(Servicio.prototype);
      Object.assign(s, { logger: { log() {}, warn() {}, error() {}, debug() {} }, tenantCtx: { requireTenantId: () => T }, tk: { run: (fn) => trx.transaction((sp) => fn(sp)) } });
      let e3 = null; let r3 = null;
      try { r3 = await s.listEvidenceByRefs(['oblig:ZZ|0|0|NO-EXISTE']); } catch (e) { e3 = e; }
      ok(!e3 && Array.isArray(r3) && r3.length === 0, `3. el servicio responde por la función (${e3 ? e3.message : 'sin error'})`);

      await M.down(trx);
      ok(!(await hayFn()) && !/payable_evidence\(/.test(await def()), '4. down(): la vista vuelve a su cuerpo completo y la función se borra');
      const vista2 = (await trx.raw('SELECT * FROM analytics.v_payable_evidence')).rows;
      ok(huella(vista2) === huella(vista), '4. down(): la vista entrega lo mismo');
      await M.up(trx);
      ok((await hayFn()) && /payable_evidence\(NULL::text\[\]\)/.test(await def()), '4. up() otra vez: la función vuelve y la vista lee de ella');

      let negado = false;
      try { M.cuerpoConLlaves('SELECT 1'); } catch { negado = true; }
      ok(negado, '5. ⛔ sin el ancla, la transformación se niega');
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { fail++; console.log('  ✗ error:', e.message); }
  } finally {
    await knex.destroy();
  }
  console.log(`\n  ${pass} ✓ · ${fail} ✗\n`);
  process.exit(fail ? 1 : 0);
})();
