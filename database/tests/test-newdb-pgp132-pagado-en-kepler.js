#!/usr/bin/env node
'use strict';
/**
 * [PGP.132] Lo que Kepler ya pagó, pagado en la Suite — servicio REAL (ts-node) contra base real, con un Kepler
 * sintético en `kepler_ods` (sucursal 00, acreedor CZZ132, año 2099), todo dentro de una transacción que se revierte.
 *
 * `pagarPorKepler()` ESCRIBE (marca pagado, liga el documento de Kepler, aplica facturas, bitácora). Verifica:
 *   1. un pago pendiente cuya factura Kepler ya saldó con un X-D-26 queda `executed`, ligado a ese X-D-26, con UNA
 *      fila `pagado_en_kepler` que dice que la Suite no lo había autorizado;
 *   2. ⛔ un pago cuya factura Kepler todavía debe sigue pendiente;
 *   3. un pago que ya pagó el banco sólo se liga a la captura (`ligado_a_kepler`), sin cambiar su estado;
 *   4. ⛔ un pago de un día que todavía no llega no se toca, aunque Kepler ya lo haya pagado;
 *   5. ⛔ correrlo otra vez no hace nada nuevo.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp132-${'x'.repeat(40)}`;
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

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp132-pagado-en-kepler');

const nada = () => undefined;
const PROV = 'CZZ132';

(async () => {
  console.log('\n[PGP.132] Lo que Kepler ya pagó, pagado en la Suite — servicio real, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    const hay = await knex.raw(`SELECT to_regclass('kepler_ods.kdxe') IS NOT NULL AND to_regclass('kepler_ods.kdxf') IS NOT NULL AS ods`);
    if (!hay.rows[0].ods) { console.log('  · NO MEDIDO: este entorno no tiene kepler_ods'); await knex.destroy(); process.exit(0); }

    await knex.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
      // ── Kepler sintético: cuatro facturas (X-A-20) y tres pagos (X-D-26) que las saldan. B queda debiéndose.
      const factura = (folio) => trx('kepler_ods.kdxe').insert({ sucursal: '00', c1: '00', c2: PROV, c3: 'A', c4: 20, c5: 1, c6: folio, c7: '2099-03-01', c11: 1000 });
      const pago = (folio, factura_, fecha) => trx('kepler_ods.kdxf').insert({
        sucursal: '00', c1: '00', c2: PROV, c3: fecha, c4: 26, c5: 1, c6: folio, c7: 20, c8: 1, c9: factura_, c10: 1000,
      });
      for (const f of ['FZZ132A', 'FZZ132B', 'FZZ132C', 'FZZ132D']) await factura(f);
      await pago('PZZ132A', 'FZZ132A', '2099-03-11');
      await pago('PZZ132C', 'FZZ132C', '2099-03-11');
      await pago('PZZ132D', 'FZZ132D', '2099-03-11');
      const oid = async (folio) => (await trx.raw(`SELECT md5('kepler_payable|00|20|1|' || ?)::uuid::text AS id`, [folio])).rows[0].id;

      // ── El Calendario: un día que ya pasó y uno que todavía no llega («hoy» = 2099-03-15).
      const lote = async (fecha) => {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
        return (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha }).returning('*'))[0];
      };
      const pasado = await lote('2099-03-10');
      const futuro = await lote('2099-03-20');
      const mk = async (lot, folio, extra = {}) => {
        const a = (await trx('finance.payment_allocations').insert({
          tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: 1000, payment_method: 'transferencia', ...extra,
        }).returning('*'))[0];
        await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a.id, obligation_source: 'kepler_payable', obligation_id: await oid(folio), applied_amount: 1000 });
        return a;
      };
      const pagadoEnKepler = await mk(pasado, 'FZZ132A');
      const debido = await mk(pasado, 'FZZ132B');
      const porBanco = await mk(pasado, 'FZZ132C', { status: 'executed', executed_at: trx.fn.now() });
      const manana = await mk(futuro, 'FZZ132D');

      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log: nada, warn: nada, error: nada, debug: nada },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
        tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
        ledger: null,
      });
      const r = await s.pagarPorKepler('2099-03-15', 'prueba_pgp132');
      const fila = (a) => trx('finance.payment_allocations').where({ id: a.id }).first();
      const hist = (a, ev) => trx('finance.payment_allocation_history').where({ allocation_id: a.id, event: ev });

      const a1 = await fila(pagadoEnKepler);
      ok(a1.status === 'executed' && a1.kepler_payment_folio === 'PZZ132A' && a1.kepler_payment_doc_prefix === 'XD2601' && a1.kepler_payment_linked_by === 'prueba_pgp132',
        `1. la factura que Kepler ya saldó: el pago queda pagado y ligado a su X-D-26 (${a1.status} · ${a1.kepler_payment_doc_prefix}-${a1.kepler_payment_folio})`);
      const h1 = await hist(pagadoEnKepler, 'pagado_en_kepler');
      ok(h1.length === 1 && (h1[0].detail.autorizado_en_la_suite === false || JSON.parse(JSON.stringify(h1[0].detail)).autorizado_en_la_suite === false),
        '1. UNA fila «pagado_en_kepler» que dice que la Suite no lo había autorizado');
      const a2 = await fila(debido);
      ok(a2.status === 'pending' && a2.kepler_payment_folio == null, '2. ⛔ la factura que Kepler todavía debe: el pago sigue pendiente');
      const a3 = await fila(porBanco);
      ok(a3.status === 'executed' && a3.kepler_payment_folio === 'PZZ132C' && (await hist(porBanco, 'ligado_a_kepler')).length === 1,
        '3. el que ya pagó el banco sólo se liga a la captura de Tesorería');
      const a4 = await fila(manana);
      ok(a4.status === 'pending' && a4.kepler_payment_folio == null, '4. ⛔ un día que todavía no llega no se toca, aunque Kepler ya lo pagó');
      ok(r.pagados === 1 && r.ligados === 1 && r.sin_autorizar === 1, `el resultado lo dice (${JSON.stringify(r)})`);

      const r2 = await s.pagarPorKepler('2099-03-15', 'prueba_pgp132');
      ok(r2.pagados === 0 && r2.ligados === 0 && (await hist(pagadoEnKepler, 'pagado_en_kepler')).length === 1, '5. ⛔ correrlo otra vez no hace nada nuevo');
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { fail++; console.log('  ✗ error:', e.message); }
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
