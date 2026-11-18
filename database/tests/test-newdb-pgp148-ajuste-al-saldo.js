#!/usr/bin/env node
'use strict';
/**
 * [PGP.148] Ajustar el pago al saldo de Kepler — servicio REAL (ts-node) contra base real, todo dentro de una
 * transacción que se revierte al final (cero efecto).
 *
 * El caso que lo pidió (Edgar, 2026-11-18): Mondelez, factura programada por $469,071.93; el 12-nov dos notas de crédito
 * bajaron su saldo a $346,929.24 y el pago salió completo. D19 (b): el pago SIN autorizar se ajusta solo; el autorizado
 * sólo avisa. ⚠️ El saldo y los abonos de Kepler (`saldosDeKepler`, `abonosDeLasFacturas`) son un DOBLE: la base de
 * pruebas no tiene Kepler. Esas dos lecturas se ejercieron contra prod en sólo lectura (ensayo del 2026-11-18). Lo que
 * se prueba aquí es lo que ESCRIBE. Verifica:
 *   1. manual: la factura baja a lo que debe, el total del pago también, UNA fila `ajustado_al_saldo` y quién;
 *   2. ⛔ autorizado: se rechaza y nada cambia;
 *   3. ⛔ ya salió del banco por su importe (la descarga): se rechaza y nada cambia;
 *   4. la factura con descuento al pagar no se toca y se dice por qué; la otra del mismo pago sí se ajusta;
 *   5. nunca sube: un saldo mayor no cambia nada;
 *   6. el worker: ajusta el de un día por venir explicado por una nota; ⛔ no el de un pago en dinero posterior a armarlo,
 *      ⛔ no el de hoy, ⛔ no el autorizado;
 *   7. ⛔ correrlo otra vez no ajusta ni registra nada nuevo.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp148-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let Servicio, D;
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
  D = require(path.join(__dirname, '../../libs/finance/src/lib/payment-calendar/debe-menos.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp148-ajuste-al-saldo');

/** El servicio real con el saldo y los abonos de Kepler sustituidos (la base de pruebas no tiene Kepler). */
function servicio(trx, saldos, abonos) {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
    tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
    ledger: null,
  });
  s.saldosDeKepler = async (_trx, ids) => new Map(ids.filter((id) => saldos.has(id)).map((id) => [id, saldos.get(id)]));
  s.abonosDeLasFacturas = async (_trx, facturas) => {
    const out = new Map();
    for (const f of facturas) { const c = D.cargoDeLaFactura(f); if (c && abonos.has(c.llave)) out.set(c.llave, abonos.get(c.llave)); }
    return out;
  };
  return s;
}

(async () => {
  console.log('\n[PGP.148] Ajustar el pago al saldo de Kepler — servicio real, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      const HOY = '2099-06-10';
      const lote = async (fecha, extra = {}) => {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
        return (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha, ...extra }).returning('*'))[0];
      };
      const lHoy = await lote(HOY), lFuturo = await lote('2099-06-20'), lPasado = await lote('2099-06-05');
      let k = 0;
      const ob = () => `00000000-0000-4000-8000-0000001480${String(++k).padStart(2, '0')}`;
      const saldos = new Map(), abonos = new Map();
      /** Un pago con sus facturas de Kepler: [{ aplicado, debe, folio, descuento, abonos }]. */
      const mk = async (lot, facturas, extra = {}) => {
        const total = facturas.reduce((s, f) => s + f.aplicado, 0);
        const a = (await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: total, created_by: 'smoke_pgp148', ...extra }).returning('*'))[0];
        const its = [];
        for (const f of facturas) {
          const id = ob();
          const ref = `oblig:00|20|1|${f.folio}`;
          if (f.debe !== undefined) saldos.set(id, { debe: f.debe, entity_ref: ref, payee_code: 'CM009' });
          if (f.abonos) abonos.set(`00|20|1|${f.folio}`, f.abonos);
          its.push((await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a.id, obligation_source: 'kepler_payable', obligation_id: id,
            applied_amount: f.aplicado, discount_amount: f.descuento ?? 0 }).returning('*'))[0]);
        }
        return { a, its };
      };
      const nc = (fecha, monto) => ({ doc: `55-${String(++k).padStart(7, '0')}`, clase: 'Nota de crédito', fecha, monto });
      const tr = (fecha, monto) => ({ doc: `26-${String(++k).padStart(7, '0')}`, clase: 'Transferencia', fecha, monto });

      const fila = (a) => trx('finance.payment_allocations').where({ id: a.id }).first();
      const item = (it) => trx('finance.payment_allocation_items').where({ id: it.id }).first();
      const hist = (a) => trx('finance.payment_allocation_history').where({ allocation_id: a.id, event: D.EVENTO_AJUSTADO_AL_SALDO });

      // ── 1. Manual: el caso Mondelez ───────────────────────────────────────────────────────────────
      const mdz = await mk(lPasado, [{ aplicado: 469071.93, debe: 346929.24, folio: '9910007', abonos: [nc('2099-06-04', 120000), nc('2099-06-04', 2142.69)] }]);
      const s = servicio(trx, saldos, abonos);
      const r1 = await s.ajustarAlSaldo(mdz.a.id, 'tesoreria_prueba', HOY);
      const a1 = await fila(mdz.a), i1 = await item(mdz.its[0]), h1 = await hist(mdz.a);
      ok(Number(i1.applied_amount) === 346929.24 && Number(a1.amount_assigned) === 346929.24 && a1.updated_by === 'tesoreria_prueba',
        `1. la factura y el pago bajan a lo que se debe (${i1.applied_amount} / ${a1.amount_assigned}) y queda quién`);
      const d1 = h1[0] && (typeof h1[0].detail === 'string' ? JSON.parse(h1[0].detail) : h1[0].detail);
      ok(h1.length === 1 && d1?.modo === 'manual' && d1?.antes === 469071.93 && d1?.despues === 346929.24 && d1?.facturas?.[0]?.abonos?.length === 2,
        '1. UNA fila «ajustado_al_saldo» con antes, después y las notas que lo explican');
      ok(r1.antes === 469071.93 && r1.amount_assigned === 346929.24 && r1.ajustadas.length === 1, '1. la respuesta dice qué ajustó');

      // ── 2. Autorizado: se rechaza ─────────────────────────────────────────────────────────────────
      const aut = await mk(lFuturo, [{ aplicado: 5000, debe: 3000, folio: '9910101', abonos: [nc('2099-06-01', 2000)] }],
        { authorized_at: trx.fn.now(), authorized_by: 'direccion_prueba' });
      let e2 = null; try { await s.ajustarAlSaldo(aut.a.id, 'tesoreria_prueba', HOY); } catch (e) { e2 = e; }
      ok(e2 && /autoriz/i.test(e2.message) && Number((await item(aut.its[0])).applied_amount) === 5000, '2. ⛔ el autorizado se rechaza y nada cambia');

      // ── 3. Ya salió del banco por su importe ─────────────────────────────────────────────────────
      await trx('finance.bank_accounts').where({ tenant_id: T }).update({ active: false });
      const cta = (await trx('finance.bank_accounts').insert({ tenant_id: T, bank: 'BBVA', account_label: 'PRUEBA-148', kind: 'bank', active: true }).returning('*'))[0];
      const arch = (await trx('finance.bank_statement_files').insert({ tenant_id: T, bank_account_id: cta.id, bank: 'bbva', file_sha1: 'pgp148-1', date_from: '2099-06-01', date_to: '2099-06-10',
        lines_in_file: 1, lines_new: 1, opening_balance: 0, closing_balance: 0, total_in: 0, total_out: 0, balance_ok: true, account_check: 'en_archivo' }).returning('*'))[0];
      const salio = await mk(lPasado, [{ aplicado: 77777.77, debe: 50000, folio: '9910201', abonos: [nc('2099-06-01', 27777.77)] }]);
      await trx('finance.bank_statement_lines').insert({ tenant_id: T, file_id: arch.id, bank_account_id: cta.id, line_no: 1, seq: 1, movement_date: '2099-06-05',
        concept: 'SPEI PRUEBA', amount_out: 77777.77, running_balance: 0, line_key: 'pgp148-l1' });
      let e3 = null; try { await s.ajustarAlSaldo(salio.a.id, 'tesoreria_prueba', HOY); } catch (e) { e3 = e; }
      ok(e3 && /salió del banco/.test(e3.message) && Number((await item(salio.its[0])).applied_amount) === 77777.77 && !(await hist(salio.a)).length,
        '3. ⛔ lo que ya salió del banco por su importe se rechaza y nada cambia');

      // ── 4. Con descuento: no se toca; la otra del mismo pago, sí ─────────────────────────────────
      const dsc = await mk(lHoy, [
        { aplicado: 970, debe: 500, folio: '9910301', descuento: 30, abonos: [nc('2099-06-01', 500)] },
        { aplicado: 2000, debe: 1500, folio: '9910302', abonos: [nc('2099-06-01', 500)] },
      ]);
      const r4 = await s.ajustarAlSaldo(dsc.a.id, 'tesoreria_prueba', HOY);
      ok(Number((await item(dsc.its[0])).applied_amount) === 970 && Number((await item(dsc.its[1])).applied_amount) === 1500
        && r4.omitidas.length === 1 && /descuento/.test(r4.omitidas[0].motivo) && Number((await fila(dsc.a)).amount_assigned) === 2470,
        '4. la factura con descuento se queda (y se dice por qué); la otra baja; el total es la suma');

      // ── 5. Nunca sube ────────────────────────────────────────────────────────────────────────────
      const sube = await mk(lHoy, [{ aplicado: 1000, debe: 1500, folio: '9910401' }]);
      const r5 = await s.ajustarAlSaldo(sube.a.id, 'tesoreria_prueba', HOY);
      ok(r5.ajustadas.length === 0 && Number((await item(sube.its[0])).applied_amount) === 1000 && !(await hist(sube.a)).length, '5. un saldo mayor no sube el pago ni deja bitácora');

      // ── 6. El worker (D19 b) ─────────────────────────────────────────────────────────────────────
      const conNota = await mk(lFuturo, [{ aplicado: 9000, debe: 6000, folio: '9910501', abonos: [nc('2026-01-01', 3000)] }]);
      const conDinero = await mk(lFuturo, [{ aplicado: 8000, debe: 1000, folio: '9910502', abonos: [tr('2099-01-01', 7000), nc('2026-01-01', 1)] }]);
      const deHoy = await mk(lHoy, [{ aplicado: 7000, debe: 4000, folio: '9910503', abonos: [nc('2026-01-01', 3000)] }]);
      const r6 = await s.ajustarLosQueDebenMenos(HOY, D.AUTOR_AJUSTE_AL_SALDO);
      const h6 = await hist(conNota.a);
      const d6 = h6[0] && (typeof h6[0].detail === 'string' ? JSON.parse(h6[0].detail) : h6[0].detail);
      ok(Number((await item(conNota.its[0])).applied_amount) === 6000 && h6.length === 1 && d6?.modo === 'automatico' && h6[0].created_by === D.AUTOR_AJUSTE_AL_SALDO,
        '6. el worker ajusta el de un día por venir explicado por una nota, y lo firma como sistema');
      ok(Number((await item(conDinero.its[0])).applied_amount) === 8000, '6. ⛔ no el que tiene un pago en dinero posterior a armarlo (lo decide una persona)');
      ok(Number((await item(deHoy.its[0])).applied_amount) === 7000, '6. ⛔ no el de hoy (pudo ya salir del banco)');
      ok(Number((await item(aut.its[0])).applied_amount) === 5000, '6. ⛔ no el autorizado');
      ok(r6.ajustados.includes(conNota.a.id) && !r6.ajustados.includes(conDinero.a.id) && r6.omitidas >= 1, `6. el resultado lo dice (${JSON.stringify({ ajustados: r6.ajustados.length, omitidas: r6.omitidas })})`);

      // ── 7. Otra vez: nada nuevo ──────────────────────────────────────────────────────────────────
      const r7 = await s.ajustarLosQueDebenMenos(HOY, D.AUTOR_AJUSTE_AL_SALDO);
      ok(!r7.ajustados.includes(conNota.a.id) && (await hist(conNota.a)).length === 1, '7. correrlo otra vez no ajusta ni registra nada nuevo');
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
