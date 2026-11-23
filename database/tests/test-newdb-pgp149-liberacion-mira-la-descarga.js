#!/usr/bin/env node
'use strict';
/**
 * [PGP.149] La liberación a la semana mira la descarga del banco, y lo que soltó por error vuelve — servicio REAL
 * (ts-node) contra base real, todo dentro de una transacción que se revierte al final (cero efecto).
 *
 * El caso que la pidió (2026-11-18): el 17-nov `[PGP.117]` liberó 7 pagos del 10-nov que SÍ habían salido del banco
 * ($1,893,556.02). Su testigo leía sólo el libro (`bank_movements`), parado desde el 10-nov; la salida estaba en la
 * DESCARGA del banco (`bank_statement_lines`). Verifica:
 *   1. el testigo del banco ve la salida que sólo está en la descarga (el defecto: antes daba «no salió»);
 *   2. sin salida y con la descarga cubriendo esos días: «no salió» (se puede liberar);
 *   3. ⛔ sin salida y una cuenta activa sin descarga de esos días: NO MEDIDO (null), se conserva;
 *   4. preparado en una cuenta cubierta: sólo esa cuenta cuenta, aunque otra esté atrasada;
 *   5. placebo: el mismo pago por $100 más no casa con nada;
 *   6. ESCRIBE: el liberado que salió del banco regresa a `pending`, con su nota y UNA fila `reabierto_salio_del_banco`
 *      que guarda la salida;
 *   7. ⛔ el liberado sin salida se queda cancelado; el que salió DESPUÉS de liberarse también;
 *   8. ⛔ el liberado cuyas facturas ya están en otro pago vivo NO se toca, y se reporta;
 *   9. ⛔ correrlo otra vez no regresa ni registra nada nuevo.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp149-${'x'.repeat(40)}`;
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
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp149-liberacion-mira-la-descarga');

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
  console.log('\n[PGP.149] La liberación mira la descarga del banco y regresa lo que soltó por error — servicio real, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      const HOY = '2099-05-20';
      // La cobertura mira TODAS las cuentas de banco activas del tenant: en esta transacción sólo las de la prueba.
      await trx('finance.bank_accounts').where({ tenant_id: T }).update({ active: false });
      const cuenta = async (bank, label) => (await trx('finance.bank_accounts')
        .insert({ tenant_id: T, bank, account_label: label, kind: 'bank', active: true }).returning('*'))[0];
      const bbva = await cuenta('BBVA', 'PRUEBA-149-1'), stdr = await cuenta('SANTANDER', 'PRUEBA-149-2');
      // [PGP.202] Activa, sin descarga nunca y sin pagos de Kepler desde ella: DORMIDA. No detiene al pago sin cuenta.
      const dormida = await cuenta('SANTANDER', 'PRUEBA-202-DORMIDA');
      let n = 0;
      const archivo = async (c, desde, hasta) => (await trx('finance.bank_statement_files').insert({
        tenant_id: T, bank_account_id: c.id, bank: c.bank.toLowerCase(), file_sha1: `pgp149-${n++}`, date_from: desde, date_to: hasta,
        lines_in_file: 1, lines_new: 1, opening_balance: 0, closing_balance: 0, total_in: 0, total_out: 0, balance_ok: true, account_check: 'en_archivo',
      }).returning('*'))[0];
      const fB = await archivo(bbva, '2099-05-01', '2099-05-19');
      const fS = await archivo(stdr, '2099-05-01', '2099-05-08');          // Santander atrasada: llega al 8
      const renglon = (c, f, fecha, monto) => trx('finance.bank_statement_lines').insert({
        tenant_id: T, file_id: f.id, bank_account_id: c.id, line_no: n, seq: n, movement_date: fecha, concept: 'SPEI PRUEBA',
        amount_out: monto, running_balance: 0, line_key: `pgp149-${n++}`,
      });

      // ── 1–5. El testigo del banco (la consulta que corre en producción) ──────────────────────────────
      await renglon(bbva, fB, '2099-05-10', 779912.56);                     // sólo en la descarga, NO en el libro
      const pagos = [
        { id: '00000000-0000-4000-8000-000000149001', monto: 779912.56, lot_date: '2099-05-10', cuenta: null },  // 1
        { id: '00000000-0000-4000-8000-000000149002', monto: 1234.56, lot_date: '2099-05-05', cuenta: null },    // 2 (todo cubierto al 5+3=8)
        { id: '00000000-0000-4000-8000-000000149003', monto: 2222.22, lot_date: '2099-05-10', cuenta: null },    // 3 (Santander no llega al 13)
        { id: '00000000-0000-4000-8000-000000149004', monto: 3333.33, lot_date: '2099-05-10', cuenta: bbva.id }, // 4 (preparado en BBVA)
        { id: '00000000-0000-4000-8000-000000149005', monto: 780012.56, lot_date: '2099-05-10', cuenta: null },  // 5 placebo +$100
        { id: '00000000-0000-4000-8000-000000202006', monto: 1234.57, lot_date: '2099-05-05', cuenta: dormida.id }, // 6 [PGP.202] preparado EN la dormida
      ];
      const t = new Map((await trx.raw(Q.SQL_SALIDA_DE_BANCO, Q.paramsSalidaDeBanco(T, HOY, pagos))).rows.map((r) => [r.id, r]));
      const w = (i) => Q.testigoDelBanco(t.get(pagos[i].id));
      ok(w(0) === true, '1. la salida que sólo está en la descarga del banco cuenta como salida (antes: «no salió»)');
      ok(w(1) === false, '2. sin salida y con la descarga cubriendo esos días: «no salió» — [PGP.202] la cuenta dormida no lo detiene');
      ok(w(5) === null && t.get(pagos[5].id).cubierto === false, '6b. [PGP.202] ⛔ preparado EN la cuenta dormida: NO MEDIDO (se conserva)');
      ok(w(2) === null && t.get(pagos[2].id).cubierto === false, '3. ⛔ sin salida y una cuenta activa sin descarga de esos días: NO MEDIDO (se conserva)');
      ok(w(3) === false, '4. preparado en una cuenta cubierta: la atrasada no lo detiene');
      ok(t.get(pagos[4].id).salio === false, '5. placebo: el mismo importe +$100 no casa con nada');

      // ── 6–9. Regresar lo liberado que salió del banco (ESCRIBE) ─────────────────────────────────────
      const lote = async (fecha) => {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
        return (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha }).returning('*'))[0];
      };
      const l10 = await lote('2099-05-10'), l25 = await lote('2099-05-25');
      const liberado = async (monto, obligacion, liberadoEl) => {
        const a = (await trx('finance.payment_allocations').insert({
          tenant_id: T, lot_id: l10.id, classification: 'gasto', amount_assigned: monto, status: 'cancelled', notes: '[liberado] prueba',
        }).returning('*'))[0];
        await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a.id, obligation_source: 'kepler_payable', obligation_id: obligacion, applied_amount: monto });
        await trx('finance.payment_allocation_history').insert({ tenant_id: T, allocation_id: a.id, event: 'liberado_por_vencimiento',
          status_from: 'pending', status_to: 'cancelled', created_by: 'smoke_pgp149', created_at: `${liberadoEl}T18:00:00Z`, detail: JSON.stringify({ regla: 'PGP.117' }) });
        return a;
      };
      const ob = (k) => `00000000-0000-4000-8000-0000001491${String(k).padStart(2, '0')}`;
      const salio = await liberado(779912.56, ob(1), '2099-05-17');          // salió el 10 (la descarga de arriba)
      const nunca = await liberado(4444.44, ob(2), '2099-05-17');            // sin salida
      const tarde = await liberado(5555.55, ob(3), '2099-05-17');            // salió DESPUÉS de liberarse
      await renglon(bbva, fB, '2099-05-19', 5555.55);
      const reprog = await liberado(6666.66, ob(4), '2099-05-17');           // salió, pero sus facturas ya están en otro pago
      await renglon(bbva, fB, '2099-05-11', 6666.66);
      const otro = (await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: l25.id, classification: 'gasto', amount_assigned: 6666.66 }).returning('*'))[0];
      await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: otro.id, obligation_source: 'kepler_payable', obligation_id: ob(4), applied_amount: 6666.66 });

      const s = servicio(trx);
      const r = await s.liberarVencidos(HOY, 'smoke_pgp149');
      const fila = (a) => trx('finance.payment_allocations').where({ id: a.id }).first();
      const hist = (a) => trx('finance.payment_allocation_history').where({ allocation_id: a.id, event: Q.EVENTO_REABIERTO });

      const u = await fila(salio);
      const h = await hist(salio);
      ok(u.status === 'pending' && /regresado 2099-05-20/.test(u.notes) && /2099-05-10/.test(u.notes), `6. el liberado que salió del banco regresa a pendiente con su nota (status ${u.status})`);
      const det = h[0] && (typeof h[0].detail === 'string' ? JSON.parse(h[0].detail) : h[0].detail);
      ok(h.length === 1 && h[0].status_from === 'cancelled' && h[0].status_to === 'pending' && det?.salida?.fecha === '2099-05-10' && Number(det?.salida?.importe) === 779912.56,
        '6. UNA fila «reabierto_salio_del_banco» con la salida que lo prueba');
      ok((await fila(nunca)).status === 'cancelled' && !(await hist(nunca)).length, '7. ⛔ el liberado sin salida se queda cancelado');
      ok((await fila(tarde)).status === 'cancelled', '7. ⛔ el que salió DESPUÉS de liberarse no regresa (no es lo que la liberación debió ver)');
      ok((await fila(reprog)).status === 'cancelled' && !(await hist(reprog)).length, '8. ⛔ el que ya tiene sus facturas en otro pago vivo no se toca');
      ok((r.ids_regresados ?? []).includes(salio.id) && (r.reprogramados_tras_liberar ?? []).includes(reprog.id),
        `8. el resultado lo dice (regresados ${r.regresados}, reprogramados ${JSON.stringify(r.reprogramados_tras_liberar?.filter((x) => x === reprog.id))})`);

      const r2 = await s.liberarVencidos(HOY, 'smoke_pgp149');
      ok(!(r2.ids_regresados ?? []).includes(salio.id) && (await hist(salio)).length === 1, '9. correrlo otra vez no regresa ni registra nada nuevo');
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
