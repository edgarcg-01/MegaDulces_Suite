#!/usr/bin/env node
'use strict';
/**
 * [PGP.121] El banco dispara el pago — servicio REAL (ts-node) contra base real, todo dentro de una transacción que
 * se revierte al final (cero efecto).
 *
 * `pagarPorElBanco()` ESCRIBE (marca pagado, guarda la evidencia y la bitácora), así que se ejerce contra Postgres
 * con las formas medidas en prod el 2026-11-13. Verifica:
 *   1. un pago sin método ni cuenta cuya salida está en el banco queda `executed`, con la cuenta del movimiento,
 *      `transferencia`, la evidencia (`paid_bank_*`) y UNA fila `pagado_por_el_banco` en la bitácora;
 *   2. ⛔ el mismo importe en dos cuentas NO se adivina: el pago sigue pendiente y sin evidencia;
 *   3. ⛔ un cheque no lo dispara el banco;
 *   4. un pago de un día que no ha llegado no se toca;
 *   5. ⛔ correrlo otra vez no hace nada nuevo (la salida ya es prueba de un pago).
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp121-${'x'.repeat(40)}`;
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
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp121-pago-por-el-banco');

function servicio(trx) {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
    tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
    ledger: null,
  });
  return s;
}

(async () => {
  console.log('\n[PGP.121] El banco dispara el pago — servicio real, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      // Un año lejano: ningún dato real cae en la ventana (60 días hacia atrás desde «hoy»).
      const HOY = '2099-03-15';
      const lote = async (fecha) => {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
        return (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha }).returning('*'))[0];
      };
      const l1 = await lote('2099-03-10'), lFuturo = await lote('2099-03-20');
      const mk = async (lot, amount, extra = {}) => (await trx('finance.payment_allocations')
        .insert({ tenant_id: T, lot_id: lot.id, classification: 'gasto', amount_assigned: amount, ...extra }).returning('*'))[0];
      const cuenta = async (bank, label) => (await trx('finance.bank_accounts')
        .insert({ tenant_id: T, bank, account_label: label, kind: 'bank' }).returning('*'))[0];
      const bbva = await cuenta('BBVA', 'PRUEBA-118-1'), banorte = await cuenta('BANORTE', 'PRUEBA-118-2');
      const edo = async (c) => (await trx('finance.bank_statements').insert({ tenant_id: T, bank_account_id: c.id, period: '2099-03' }).returning('*'))[0];
      const eB = await edo(bbva), eN = await edo(banorte);
      let n = 0;
      const salida = async (c, e, fecha, monto) => (await trx('finance.bank_movements').insert({
        tenant_id: T, bank_account_id: c.id, statement_id: e.id, movement_date: fecha, amount_out: monto, client_uuid: `pgp121-${Date.now()}-${n++}`,
      }).returning('*'))[0];

      const unico = await mk(l1, 452754.08);                         // 1. sin método ni cuenta
      const doble = await mk(l1, 1500);                              // 2. mismo importe en dos cuentas
      const cheque = await mk(l1, 7777.77, { payment_method: 'cheque' }); // 3. cheque
      const futuro = await mk(lFuturo, 3333.33);                     // 4. su día no ha llegado
      const mU = await salida(bbva, eB, '2099-03-11', 452754.08);
      await salida(bbva, eB, '2099-03-10', 1500); await salida(banorte, eN, '2099-03-10', 1500);
      await salida(bbva, eB, '2099-03-10', 7777.77);
      await salida(bbva, eB, '2099-03-14', 3333.33);

      const s = servicio(trx);
      const r = await s.pagarPorElBanco(HOY, 'smoke_pgp121');
      const fila = async (a) => trx('finance.payment_allocations').where({ id: a.id }).first();

      const u = await fila(unico);
      ok(u.status === 'executed' && u.bank_account_id === bbva.id && u.payment_method === 'transferencia',
        `1. pagado con la cuenta del movimiento y «transferencia» (status ${u.status}, método ${u.payment_method})`);
      ok(u.paid_bank_movement_id === mU.id && Number(u.paid_bank_amount) === 452754.08 && u.paid_validated_at != null,
        '1. guarda la evidencia del banco (movimiento, importe, validado)');
      const h = await trx('finance.payment_allocation_history').where({ allocation_id: unico.id });
      ok(h.length === 1 && h[0].event === 'pagado_por_el_banco' && h[0].status_to === 'executed', '1. UNA fila «pagado_por_el_banco» en la bitácora');

      const d = await fila(doble);
      ok(d.status === 'pending' && d.paid_bank_movement_id == null, '2. el mismo importe en dos cuentas NO se adivina');
      const c = await fila(cheque);
      ok(c.status === 'pending', '3. el cheque no lo dispara el banco');
      const f = await fila(futuro);
      ok(f.status === 'pending', '4. el pago de un día que no ha llegado no se toca');
      ok(r.pagados === 1 && r.sin_decidir.varias_cuentas === 1 && r.sin_decidir.excluido === 1, `el resultado lo dice (${JSON.stringify(r)})`);

      const r2 = await s.pagarPorElBanco(HOY, 'smoke_pgp121');
      const h2 = await trx('finance.payment_allocation_history').where({ allocation_id: unico.id });
      ok(r2.pagados === 0 && h2.length === 1, '5. correrlo otra vez no paga ni registra nada nuevo');
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
