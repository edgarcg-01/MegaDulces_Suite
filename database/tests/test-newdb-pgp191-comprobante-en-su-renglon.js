#!/usr/bin/env node
'use strict';
/**
 * [PGP.191] El PDF soltado sobre el renglón de su pago — servicios REALES (ts-node) contra base real, todo dentro de una
 * transacción que se revierte al final (cero efecto).
 *
 * `comprobanteDelRenglon()` ESCRIBE (guarda el comprobante, fija la cuenta de origen, bitácora) y el worker
 * `pagarPorComprobante()` lo aplica, así que se ejercen contra Postgres. La lectura del PDF (modelo) y el bucket se
 * sustituyen en la instancia: lo que se prueba es lo que pasa DESPUÉS de leer. Verifica:
 *   1. un pago ya pagado (autorizado, ejecutado): su PDF se liga (`CAL`, validado), con UNA fila `comprobante_soltado`;
 *      el worker sólo lo liga (`paid_proof_id`) y no lo vuelve a «pagar»;
 *   2. ⭐ DA1: un pago pasado, pendiente, SIN autorizar y nunca preparado: se liga marcado `sin_autorizar`, toma la cuenta
 *      que leyó el PDF y el método transferencia; la bitácora dice `autorizado_en_la_suite: false`; el worker lo da por
 *      pagado (`pagado_por_comprobante`);
 *   3. ⛔ otro importe: no se liga, dice los dos importes, sin fila y SIN subir el archivo;
 *   4. ⛔ preparado con otra cuenta nuestra: no;
 *   5. ⛔ un segundo PDF sobre el mismo pago: no («ya tiene»);
 *   6. ⛔ la misma clave de rastreo ya ligada a otro pago: `repetido`, sin fila;
 *   7. ⛔ un pago cancelado y uno con cheque: no;
 *   8. ⛔ ligado a un X-D-26 que ya tiene su comprobante en Comprobantes de pago: no («ya tiene»), sin duplicar;
 *   9. ⛔ un PDF ilegible: `sin_lectura`, sin subir nada;
 *  10. ⛔ un id que no es de un pago: error, sin fila;
 *  11. `[PGP.192]` el ensayo del escritor lee `autorizado` del pago (la columna nueva del SELECT existe y se calcula);
 *  12. ⛔ una imagen se rechaza ANTES de leerla: el comprobante sólo se guarda en PDF.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp191-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let Calendario, Comprobantes;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  const lib = path.join(__dirname, '../../libs/finance/src/lib');
  ({ PaymentCalendarService: Calendario } = require(path.join(lib, 'payment-calendar/payment-calendar.service.ts')));
  ({ SupplierPaymentProofsService: Comprobantes } = require(path.join(lib, 'supplier-payment-proofs/supplier-payment-proofs.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp191-comprobante-en-su-renglon');

const nada = () => undefined;
const silencio = { log: nada, warn: nada, error: nada, debug: nada };
const comunes = (trx) => ({
  logger: silencio,
  tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
  tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
});
const HOY = '2099-03-25';
const PDF = 'data:application/pdf;base64,AAAA';

(async () => {
  console.log('\n[PGP.191] El PDF soltado sobre el renglón de su pago — servicios reales, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      // Un año lejano: ningún dato real cae cerca.
      const lote = async (fecha, status) => {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
        return (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha, ...(status ? { status } : {}) }).returning('*'))[0];
      };
      const firmado = await lote('2099-03-10', 'released');
      const sinFirmar = await lote('2099-03-19');
      // Etiquetas de cuenta que ninguna cuenta real termina igual.
      const cuenta = (await trx('finance.bank_accounts').insert({ tenant_id: T, bank: 'BBVA', account_label: '7719199191', kind: 'bank' }).returning('*'))[0];
      const otra = (await trx('finance.bank_accounts').insert({ tenant_id: T, bank: 'SANTANDER', account_label: '8819199192', kind: 'bank' }).returning('*'))[0];
      const mk = async (lot, amount, extra = {}) => (await trx('finance.payment_allocations').insert({
        tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: amount,
        payment_method: 'transferencia', bank_account_id: cuenta.id, ...extra,
      }).returning('*'))[0];
      const pagado = await mk(firmado, 191191.11, { status: 'executed', executed_at: trx.fn.now(), authorized_at: trx.fn.now() });
      const pasado = await mk(sinFirmar, 64646.46, { payment_method: null, bank_account_id: null });
      const preparadoConOtra = await mk(firmado, 5555.55, { bank_account_id: otra.id });
      const cancelado = await mk(firmado, 7777.77, { status: 'cancelled' });
      const conCheque = await mk(firmado, 8888.88, { payment_method: 'cheque' });
      const ligadoKepler = await mk(firmado, 9999.99, {
        status: 'executed', executed_at: trx.fn.now(), kepler_payment_sucursal: '00', kepler_payment_doc_prefix: 'XD2601', kepler_payment_folio: '9919100',
      });
      await trx('finance.supplier_payment_proofs').insert({
        tenant_id: T, sucursal: '00', doc_prefix: 'XD2601', folio: '9919100', metodo_pago: 'transferencia', pago_monto: 9999.99,
        files: JSON.stringify([]), status: 'validado', created_by: 'prueba_pgp191',
      });

      let lectura = null, subidas = 0;
      const comp = Object.create(Comprobantes.prototype);
      Object.assign(comp, comunes(trx), {
        runOcr: async () => ({ ...lectura, sha256: `sha-${Math.random()}` }),
        uploadFile: async () => { subidas++; return { role: 'comprobante', url: 'prueba/pgp191.pdf', kind: 'pdf' }; },
      });
      const leer = (o) => { lectura = {
        monto: 191191.11, fecha: '2099-03-10', cuenta_origen: '0489 7719 1991 91', beneficiario: 'PROVEEDOR PRUEBA 191',
        clave_rastreo: 'PGP191RASTREO1', concepto: 'PAGO FACTURAS', cuenta_destino: null, banco_destino: 'CITI', metodo: 'SPEI',
        ocr_status: 'ok', ...o,
      }; };
      const filasCal = async (folio) => trx('finance.supplier_payment_proofs').where({ tenant_id: T, doc_prefix: 'CAL', folio });
      const soltar = (id) => comp.comprobanteDelRenglon(id, PDF, 'prueba_pgp191', HOY);
      const cal = Object.create(Calendario.prototype);
      Object.assign(cal, comunes(trx), { ledger: null });

      // 1. ya pagado
      leer();
      const r1 = await soltar(pagado.id);
      ok(r1.estado === 'ligado' && !!r1.comprobante_id && r1.sin_autorizar === false, `1. el PDF del pago ya pagado se liga (${r1.estado}${r1.motivo ? ': ' + r1.motivo : ''})`);
      const f1 = await filasCal(pagado.id);
      ok(f1.length === 1 && f1[0].status === 'validado' && Number(f1[0].ocr_monto) === 191191.11 && f1[0].ref_norm === 'PGP191RASTREO1',
        '1. se guarda validado, apuntando al pago (CAL / id del pago), con lo leído');
      const h1 = await trx('finance.payment_allocation_history').where({ allocation_id: pagado.id, event: 'comprobante_soltado' });
      ok(h1.length === 1 && h1[0].status_from === 'executed' && h1[0].status_to === 'executed', '1. UNA fila «comprobante_soltado», sin cambiar el estado');

      // 2. DA1: pasado, sin autorizar, nunca preparado
      leer({ monto: 64646.46, fecha: '2099-03-18', clave_rastreo: 'PGP191RASTREO2' });
      const r2 = await soltar(pasado.id);
      ok(r2.estado === 'ligado' && r2.sin_autorizar === true, `2. ⭐ DA1: el pago sin autorizar se liga, marcado «sin autorizar» (${r2.estado}${r2.motivo ? ': ' + r2.motivo : ''})`);
      const p2 = await trx('finance.payment_allocations').where({ id: pasado.id }).first();
      ok(p2.bank_account_id === cuenta.id && p2.payment_method === 'transferencia' && p2.status === 'pending',
        '2. toma la cuenta que leyó el PDF y el método transferencia (el worker es quien lo paga)');
      const h2 = await trx('finance.payment_allocation_history').where({ allocation_id: pasado.id, event: 'comprobante_soltado' }).first();
      const d2 = typeof h2?.detail === 'string' ? JSON.parse(h2.detail) : h2?.detail;
      ok(d2 && d2.autorizado_en_la_suite === false && d2.cuenta_fijada === cuenta.id, '2. la bitácora dice que no estaba autorizado y qué cuenta se fijó');

      // El worker aplica los dos: al pagado sólo lo liga; al pendiente lo da por pagado.
      const w = await cal.pagarPorComprobante('prueba_pgp191');
      const p1w = await trx('finance.payment_allocations').where({ id: pagado.id }).first();
      const p2w = await trx('finance.payment_allocations').where({ id: pasado.id }).first();
      ok(p1w.status === 'executed' && p1w.paid_proof_id === r1.comprobante_id, '1. el worker liga el comprobante al pago ya pagado');
      ok(p2w.status === 'executed' && p2w.paid_proof_id === r2.comprobante_id, `2. el worker da por pagado el pago pasado (${JSON.stringify({ pagados: w.pagados, ligados: w.ligados })})`);
      ok((await trx('finance.payment_allocation_history').where({ allocation_id: pasado.id, event: 'pagado_por_comprobante' })).length === 1,
        '2. UNA fila «pagado_por_comprobante» en la bitácora');

      // 3. otro importe: no se sube nada
      let antes = subidas;
      leer({ monto: 5600.00, clave_rastreo: 'PGP191RASTREO3', cuenta_origen: '8819199192' });
      const r3 = await soltar(preparadoConOtra.id);
      ok(r3.estado === 'no' && /5,600\.00/.test(r3.motivo) && /5,555\.55/.test(r3.motivo) && subidas === antes && (await filasCal(preparadoConOtra.id)).length === 0,
        `3. ⛔ otro importe no se liga y no sube el archivo (${r3.motivo})`);

      // 4. preparado con otra cuenta
      leer({ monto: 5555.55, clave_rastreo: 'PGP191RASTREO4' });
      const r4 = await soltar(preparadoConOtra.id);
      ok(r4.estado === 'no' && /otra cuenta/.test(r4.motivo) && (await filasCal(preparadoConOtra.id)).length === 0, `4. ⛔ sale de otra cuenta que la preparada (${r4.motivo})`);

      // 5. un segundo PDF sobre el mismo pago
      leer({ clave_rastreo: 'PGP191RASTREO5' });
      const r5 = await soltar(pagado.id);
      ok(r5.estado === 'no' && /ya tiene/.test(r5.motivo) && (await filasCal(pagado.id)).length === 1, `5. ⛔ un segundo PDF sobre el mismo pago (${r5.motivo})`);

      // 6. la misma clave de rastreo, ahora para otro pago (de la cuenta y el importe correctos)
      leer({ monto: 5555.55, cuenta_origen: '8819199192', clave_rastreo: 'PGP191-RASTREO1' });
      const r6 = await soltar(preparadoConOtra.id);
      ok(r6.estado === 'repetido' && (await filasCal(preparadoConOtra.id)).length === 0, `6. ⛔ la misma clave de rastreo ya ligada (${r6.estado})`);

      // 7. cancelado y cheque
      leer({ monto: 7777.77, clave_rastreo: 'PGP191RASTREO7' });
      const r7a = await soltar(cancelado.id);
      leer({ monto: 8888.88, clave_rastreo: 'PGP191RASTREO7B' });
      const r7b = await soltar(conCheque.id);
      ok(r7a.estado === 'no' && /cancelado/.test(r7a.motivo) && r7b.estado === 'no' && /cheque/.test(r7b.motivo), '7. ⛔ cancelado y cheque: no');

      // 8. ya tiene su comprobante en su X-D-26
      leer({ monto: 9999.99, clave_rastreo: 'PGP191RASTREO8' });
      const r8 = await soltar(ligadoKepler.id);
      ok(r8.estado === 'no' && /ya tiene/.test(r8.motivo) && (await filasCal(ligadoKepler.id)).length === 0,
        `8. ⛔ su X-D-26 ya tiene comprobante: no se duplica (${r8.motivo})`);

      // 9. ilegible
      antes = subidas;
      leer({ ocr_status: 'ilegible', monto: null, fecha: null });
      const r9 = await soltar(cancelado.id);
      ok(r9.estado === 'sin_lectura' && subidas === antes, `9. ⛔ un PDF ilegible no se liga ni se sube (${r9.estado})`);

      // 10. id que no es de un pago
      leer();
      let e10 = null;
      try { await soltar('no-es-un-id'); } catch (e) { e10 = e; }
      let e10b = null;
      try { await soltar('00000000-0000-0000-0000-000000019100'); } catch (e) { e10b = e; }
      ok(!!e10 && !!e10b, '10. ⛔ un id inválido o de un pago que no existe: error, sin fila');

      // 12. una imagen: se rechaza antes de leerla (el comprobante sólo se guarda en PDF)
      let lecturas = 0;
      const ocrOriginal = comp.runOcr;
      comp.runOcr = async (...args) => { lecturas++; return ocrOriginal(...args); };
      let e12 = null;
      try { await comp.comprobanteDelRenglon(preparadoConOtra.id, 'data:image/png;base64,AAAA', 'prueba_pgp191', HOY); } catch (e) { e12 = e; }
      comp.runOcr = ocrOriginal;
      ok(!!e12 && /PDF/.test(e12.message) && lecturas === 0 && (await filasCal(preparadoConOtra.id)).length === 0,
        '12. ⛔ una imagen se rechaza antes de leerla, sin fila');

      // 11. [PGP.192] el ensayo del escritor calcula `autorizado` (la consulta con la columna nueva corre)
      const q = await trx.raw(`
        SELECT (a.authorized_at IS NOT NULL OR l.status IN ('released', 'executing', 'closed')) AS autorizado
          FROM finance.payment_allocations a JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
         WHERE a.tenant_id = ? AND a.id = ANY(?::uuid[]) ORDER BY a.amount_assigned DESC`, [T, [pagado.id, pasado.id]]);
      ok(q.rows.length === 2 && q.rows[0].autorizado === true && q.rows[1].autorizado === false,
        '11. [PGP.192] el pagado autorizado da true y el pasado sin autorizar da false (lo que retiene el escritor)');

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
