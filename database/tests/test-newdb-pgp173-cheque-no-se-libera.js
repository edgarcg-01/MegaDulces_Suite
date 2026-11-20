#!/usr/bin/env node
'use strict';
/**
 * [PGP.173] La liberación a la semana no suelta un cheque emitido — servicio REAL (ts-node) contra base real, todo
 * dentro de una transacción que se revierte al final (cero efecto).
 *
 * El caso (2026-11-19): Kepler registra el cheque hasta que se cobra y el banco no tiene salida mientras el proveedor
 * no lo deposite, así que para los dos testigos de `[PGP.117]` un cheque entregado y sin depositar es «nadie lo pagó».
 * El 17-nov se liberó así el 5383 (ya cobrado; lo regresó `[PGP.149]`). Liberarlo vuelve a ofrecer sus facturas y, si
 * el proveedor llama después y se libera en el banco, se pagan dos veces.
 *
 * Kepler se SIMULA («sus facturas siguen sin pagar», que es lo que dice de un cheque en tránsito): lo demás es real —
 * la consulta de vencidos con su predicado `cheque_emitido`, el testigo del banco con su cobertura, la regla y la
 * escritura de la liberación con su bitácora. Verifica:
 *   1. la consulta de vencidos marca `cheque_emitido` sólo en el pago con método cheque Y número en la referencia;
 *   2. ⛔ ESCRIBE: el cheque con número se queda `pending`, sin fila `liberado_por_vencimiento`, y se cuenta como
 *      `cheque_emitido`;
 *   3. controles (la prueba negativa): el mismo pago por transferencia, el cheque sin número y el cheque con una
 *      referencia sin dígitos SÍ se liberan, cada uno con su fila en la bitácora — la regla de siempre sigue viva;
 *   4. correrlo otra vez no suelta el cheque.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp173-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let Servicio, Q;
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
  Q = require(path.join(__dirname, '../../libs/finance/src/lib/payment-calendar/pagos-vencidos.sql.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp173-cheque-no-se-libera');

/** Kepler simulado: cada factura del pago sigue sin pagar (lo que Kepler dice de un cheque que no se ha cobrado). */
const sinPagar = { estado: 'sin_pagar', desfase_dias: null, pagado: 0, pagos: [],
  facturas: { pagada: 0, saldada_sin_dinero: 0, en_parte: 0, sin_pagar: 1, sin_medir: 0 } };

function servicio(trx) {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
    tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
    ledger: null,
  });
  s.cierresKepler = async (_trx, pagos) => new Map(pagos.map((p) => [p.id, sinPagar]));
  return s;
}

(async () => {
  console.log('\n[PGP.173] La liberación a la semana no suelta un cheque emitido — servicio real, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      const HOY = '2099-06-20';
      const DIA = '2099-06-10';                                             // 10 días antes: ya «vencido»
      // El banco «cubre» esos días y no tiene salida por esos importes: el testigo del banco dice «no salió».
      await trx('finance.bank_accounts').where({ tenant_id: T }).update({ active: false });
      const cta = (await trx('finance.bank_accounts')
        .insert({ tenant_id: T, bank: 'BAJIO', account_label: 'PRUEBA-173', kind: 'bank', active: true }).returning('*'))[0];
      await trx('finance.bank_statement_files').insert({
        tenant_id: T, bank_account_id: cta.id, bank: 'bajio', file_sha1: 'pgp173-1', date_from: '2099-06-01', date_to: '2099-06-19',
        lines_in_file: 0, lines_new: 0, opening_balance: 0, closing_balance: 0, total_in: 0, total_out: 0, balance_ok: true, account_check: 'en_archivo',
      });
      await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: DIA }).del();
      const lote = (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: DIA }).returning('*'))[0];

      let k = 0;
      const pago = async (metodo, referencia, monto) => {
        const a = (await trx('finance.payment_allocations').insert({
          tenant_id: T, lot_id: lote.id, classification: 'proveedor_mercancia', amount_assigned: monto, status: 'pending',
          payment_method: metodo, reference_text: referencia,
        }).returning('*'))[0];
        await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a.id, obligation_source: 'kepler_payable',
          obligation_id: `00000000-0000-4000-8000-0000001730${String(++k).padStart(2, '0')}`, applied_amount: monto });
        return a;
      };
      const cheque = await pago('cheque', '5501', 173001.11);               // emitido: método cheque + número
      const transf = await pago('transferencia', '5502', 173002.22);        // control: mismo número, otro método
      const sinNum = await pago('cheque', null, 173003.33);                 // control: cheque sin número (sin papel)
      const sinDig = await pago('cheque', 'POR LLENAR', 173004.44);         // control: referencia sin dígitos

      // ── 1. La consulta de vencidos ────────────────────────────────────────────────────────────────
      const filas = new Map((await trx.raw(Q.SQL_PENDIENTES_VENCIDOS, [T, HOY])).rows.map((r) => [r.id, r]));
      const ce = (a) => filas.get(a.id)?.cheque_emitido;
      ok(ce(cheque) === true, '1. el cheque con número sale como cheque_emitido');
      ok(ce(transf) === false && ce(sinNum) === false && ce(sinDig) === false,
        `1. transferencia, cheque sin número y referencia sin dígitos NO (${ce(transf)}, ${ce(sinNum)}, ${ce(sinDig)})`);

      // ── 2–3. La pasada real ───────────────────────────────────────────────────────────────────────
      const s = servicio(trx);
      const r = await s.liberarVencidos(HOY, 'smoke_pgp173');
      const fila = (a) => trx('finance.payment_allocations').where({ id: a.id }).first();
      const lib = (a) => trx('finance.payment_allocation_history').where({ allocation_id: a.id, event: 'liberado_por_vencimiento' });

      ok((await fila(cheque)).status === 'pending' && !(await lib(cheque)).length, '2. ⛔ el cheque emitido se queda pendiente y sin fila de liberación');
      ok(r.conservados.cheque_emitido >= 1 && !r.ids_liberados.includes(cheque.id),
        `2. el resultado lo cuenta como cheque_emitido (${r.conservados.cheque_emitido}) y no lo lista como liberado`);
      for (const [a, m] of [[transf, 'la transferencia'], [sinNum, 'el cheque sin número'], [sinDig, 'la referencia sin dígitos']]) {
        ok((await fila(a)).status === 'cancelled' && (await lib(a)).length === 1 && r.ids_liberados.includes(a.id),
          `3. control: ${m} SÍ se libera, con su fila en la bitácora (la regla de siempre sigue viva)`);
      }

      // ── 4. Otra pasada ────────────────────────────────────────────────────────────────────────────
      const r2 = await s.liberarVencidos(HOY, 'smoke_pgp173');
      ok((await fila(cheque)).status === 'pending' && !r2.ids_liberados.includes(cheque.id), '4. correrlo otra vez no suelta el cheque');
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
