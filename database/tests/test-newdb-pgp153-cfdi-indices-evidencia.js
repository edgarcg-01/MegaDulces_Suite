#!/usr/bin/env node
'use strict';
/**
 * [PGP.153] Los índices de CFDI para la evidencia — contra base real (en el CI, después de `migrate:latest`), sólo lee.
 * Verifica:
 *   1. los dos índices parciales de `fiscal.cfdis` existen y son VÁLIDOS;
 *   2. la función `analytics.payable_evidence` ya no materializa `cfd`;
 *   3. la función con NULL sigue entregando lo mismo que la vista (conteo y huella);
 *   4. ⛔ la expresión del índice de folio es la MISMA que usa la función (si difiere, el índice no se usa nunca).
 * El ida y vuelta (`down`/`up`) no se prueba aquí: `CREATE/DROP INDEX CONCURRENTLY` no corre dentro de una transacción.
 */
const path = require('path');
const crypto = require('crypto');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const M = require(path.join(__dirname, '../migrations-newdb/20261118150455_pgp153_cfdi_indices_para_evidencia.js'));

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp153-cfdi-indices-evidencia');

(async () => {
  console.log('\n[PGP.153] Índices de CFDI para la evidencia — sólo lectura\n');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      const fn = (await trx.raw(`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('analytics.payable_evidence(text[])')`)).rows[0];
      if (!fn) { console.log('  ·  NO MEDIDO — la migración 20261118144337 (PGP.152) no está aplicada'); return; }
      for (const ix of M.INDICES) {
        const r = (await trx.raw(`SELECT i.indisvalid AS valido, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fiscal' AND c.relname = ?`, [ix.nombre])).rows[0];
        ok(!!r && r.valido, `1. fiscal.${ix.nombre} existe y es válido`);
      }
      ok(String(fn.prosrc).includes('cfd AS NOT MATERIALIZED ('), '2. la función ya no materializa cfd');
      const huella = (rows) => crypto.createHash('sha1').update(rows.map((x) => JSON.stringify(x)).sort().join('\n')).digest('hex');
      const vista = (await trx.raw('SELECT * FROM analytics.v_payable_evidence')).rows;
      const fnTodo = (await trx.raw('SELECT * FROM analytics.payable_evidence(NULL::text[])')).rows;
      ok(vista.length === fnTodo.length && huella(vista) === huella(fnTodo), `3. la función con NULL = la vista (${vista.length} filas)`);
      // La expresión del índice, normalizada por Postgres, tiene que aparecer en el CTE cfd de la función.
      const def = (await trx.raw(`SELECT pg_get_indexdef(c.oid) AS d FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fiscal' AND c.relname = 'ix_fiscal_cfdis_recibidas_folio_n'`)).rows[0]?.d ?? '';
      const exprIndice = (/regexp_replace\(COALESCE\(folio, ''::text\), '\[\^0-9\]'::text, ''::text, 'g'::text\)/).test(def);
      const exprFuncion = String(fn.prosrc).includes("regexp_replace(COALESCE(cfdis.folio, ''::text), '[^0-9]'::text, ''::text, 'g'::text)");
      ok(exprIndice && exprFuncion, '4. la expresión del folio es la misma en el índice y en la función');
    });
    // 5. Los usos de la app leen la función por llaves (servicio REAL, ts-node) — en una transacción que se revierte.
    let Servicio = null;
    try {
      require('ts-node').register({ transpileOnly: true, skipProject: true,
        compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
      const tsc = require('typescript');
      const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
      require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
      require('reflect-metadata');
      process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp153-${'x'.repeat(40)}`;
      ({ PaymentCalendarService: Servicio } = require(path.join(__dirname, '../../libs/finance/src/lib/payment-calendar/payment-calendar.service.ts')));
    } catch (e) { console.log(`  ·  NO MEDIDO (5) — no se pudo cargar el servicio real: ${e.message}`); }
    if (Servicio) {
      const ROLLBACK = new Error('rollback');
      try {
        await knex.transaction(async (trx) => {
          await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
          const s = Object.create(Servicio.prototype);
          Object.assign(s, { logger: { log() {}, warn() {}, error() {}, debug() {} }, tenantCtx: { requireTenantId: () => T }, tk: { run: (fn) => trx.transaction((sp) => fn(sp)) } });
          let e5 = null;
          try { await s.listPayableEvidence('ZZ-NO-EXISTE'); } catch (e) { e5 = e; }
          ok(!e5, `5. la evidencia por proveedor responde por la función (${e5 ? e5.message : 'sin error'})`);
          // Un día con un pago de una factura de Kepler (que no existe en Kepler): el desglose arma su consulta con la función.
          const fecha = '2099-05-01';
          await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
          const lot = (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha }).returning('*'))[0];
          const a = (await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: 100 }).returning('*'))[0];
          await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a.id, obligation_source: 'kepler_payable', obligation_id: '00000000-0000-4000-8000-000000153001', applied_amount: 100 });
          let e6 = null; let lineas = null;
          try { lineas = await s.detalleExpediente(fecha); } catch (e) { e6 = e; }
          ok(!e6 && Array.isArray(lineas), `5. el desglose del Preliminar responde por la función (${e6 ? e6.message : `${lineas.length} líneas`})`);
          throw ROLLBACK;
        });
      } catch (e) { if (e !== ROLLBACK) { fail++; console.log('  ✗ error (5):', e.message); } }
    }
  } catch (e) {
    fail++; console.log('  ✗ error:', e.message);
  } finally {
    await knex.destroy();
  }
  console.log(`\n  ${pass} ✓ · ${fail} ✗\n`);
  process.exit(fail ? 1 : 0);
})();
