#!/usr/bin/env node
'use strict';
/**
 * [PGP.130] El comprobante dispara el pago — servicios REALES (ts-node) contra base real, todo dentro de una
 * transacción que se revierte al final (cero efecto).
 *
 * `comprobanteDelCalendario()` y `pagarPorComprobante()` ESCRIBEN (guardan el comprobante, marcan pagado, aplican
 * facturas, bitácora), así que se ejercen contra Postgres. La lectura del PDF (modelo) y el bucket se sustituyen
 * en la instancia: lo que se prueba es lo que pasa DESPUÉS de leer. Verifica:
 *   1. el comprobante de un pago autorizado, misma cuenta/importe/fecha, CASA: se guarda `validado`, apuntando al
 *      pago (`doc_prefix = 'CAL'`, `folio` = id del pago), sin tocar todavía el pago;
 *   2. ⛔ el mismo comprobante otra vez: `ya_tiene`, sin fila nueva;
 *   3. ⛔ un pago sin autorizar no lo paga un comprobante (`sin_autorizar`), sin fila;
 *   4. ⛔ una cuenta de origen que no es nuestra no casa (`sin_lectura`), sin fila;
 *   5. ⛔ la misma clave de rastreo en otro comprobante vivo: `repetido`, sin fila;
 *   6. ⛔ un PDF ilegible: `sin_lectura`, sin subir nada al bucket;
 *   7. `pagarPorComprobante` lo da por pagado (`executed`, `paid_proof_id`, UNA fila `pagado_por_comprobante`);
 *      correrlo otra vez no hace nada nuevo;
 *   8. la fila del worker de Kepler (`SQL_PROBADOS_SIN_LIGAR`) lo toma sin salida del banco;
 *   9. al escribirse el `X-D-26`, el comprobante pasa a apuntar a ese documento (`moverComprobanteAKepler`).
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp130-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let Calendario, Comprobantes, sqlBanco, porComprobante;
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
  sqlBanco = require(path.join(lib, 'payment-calendar/pago-por-el-banco.sql.ts'));
  porComprobante = require(path.join(lib, 'payment-calendar/pago-por-comprobante.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp130-comprobante-dispara');

const nada = () => undefined;
const silencio = { log: nada, warn: nada, error: nada, debug: nada };
const comunes = (trx) => ({
  logger: silencio,
  tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
  tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
});

(async () => {
  console.log('\n[PGP.130] El comprobante dispara el pago — servicios reales, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      // Un año lejano: ningún dato real cae en la ventana (±5 días).
      const lote = async (fecha, status) => {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
        return (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha, ...(status ? { status } : {}) }).returning('*'))[0];
      };
      const firmado = await lote('2099-03-10', 'released');
      const sinFirmar = await lote('2099-03-20');
      // Una etiqueta de cuenta que ninguna cuenta real termina igual.
      const cuenta = (await trx('finance.bank_accounts')
        .insert({ tenant_id: T, bank: 'BBVA', account_label: '7713099130', kind: 'bank' }).returning('*'))[0];
      const mk = async (lot, amount, extra = {}) => (await trx('finance.payment_allocations').insert({
        tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: amount,
        payment_method: 'transferencia', bank_account_id: cuenta.id, ...extra,
      }).returning('*'))[0];
      const pago = await mk(firmado, 511359.31);
      const pagoSinAutorizar = await mk(sinFirmar, 222222.22);
      const otroPago = await mk(firmado, 333333.33);

      // El servicio de comprobantes, con la lectura y el bucket sustituidos.
      let lectura = null, subidas = 0;
      const comp = Object.create(Comprobantes.prototype);
      Object.assign(comp, comunes(trx), {
        runOcr: async () => ({ ...lectura, sha256: `sha-${Math.random()}` }),
        uploadFile: async () => { subidas++; return { role: 'comprobante', url: 'prueba/pgp130.pdf', kind: 'pdf' }; },
      });
      const leer = (o) => { lectura = {
        monto: 511359.31, fecha: '2099-03-10', cuenta_origen: '0021 8077 1309 9130', beneficiario: 'PROVEEDOR PRUEBA 130',
        clave_rastreo: 'PGP130RASTREO1', concepto: 'PAGO FACTURAS', cuenta_destino: null, banco_destino: 'BANORTE', metodo: 'SPEI',
        ocr_status: 'ok', ...o,
      }; };
      const filasCal = async (folio) => trx('finance.supplier_payment_proofs').where({ tenant_id: T, doc_prefix: 'CAL', folio });

      // 1. casa
      leer();
      const r1 = await comp.comprobanteDelCalendario('data:application/pdf;base64,AAAA', 'prueba_pgp130');
      ok(r1.estado === 'casa' && r1.pago_id === pago.id && !!r1.comprobante_id, `1. casa con su pago (${r1.estado}${r1.motivo ? ': ' + r1.motivo : ''})`);
      const f1 = await filasCal(pago.id);
      ok(f1.length === 1 && f1[0].status === 'validado' && f1[0].sucursal === 'CAL' && Number(f1[0].ocr_monto) === 511359.31 && f1[0].ref_norm === 'PGP130RASTREO1',
        '1. se guarda validado, apuntando al pago (CAL / id del pago), con lo leído');
      const p1 = await trx('finance.payment_allocations').where({ id: pago.id }).first();
      ok(p1.status === 'pending' && p1.paid_proof_id == null, '1. el pago todavía no se toca: lo aplica el worker');

      // 2. el mismo otra vez
      const r2 = await comp.comprobanteDelCalendario('data:application/pdf;base64,AAAA', 'prueba_pgp130');
      ok(r2.estado === 'ya_tiene' && (await filasCal(pago.id)).length === 1, `2. ⛔ el mismo comprobante otra vez: ${r2.estado}, sin fila nueva`);

      // 3. sin autorizar
      leer({ monto: 222222.22, fecha: '2099-03-20', clave_rastreo: 'PGP130RASTREO3' });
      const r3 = await comp.comprobanteDelCalendario('data:application/pdf;base64,AAAA', 'prueba_pgp130');
      ok(r3.estado === 'sin_autorizar' && r3.pago_id === pagoSinAutorizar.id && (await filasCal(pagoSinAutorizar.id)).length === 0,
        `3. ⛔ un pago sin autorizar no lo paga un comprobante (${r3.estado}), sin fila`);

      // 4. cuenta ajena
      leer({ monto: 333333.33, cuenta_origen: '0000 1111 2222 3333', clave_rastreo: 'PGP130RASTREO4' });
      const r4 = await comp.comprobanteDelCalendario('data:application/pdf;base64,AAAA', 'prueba_pgp130');
      ok(r4.estado === 'sin_lectura' && (await filasCal(otroPago.id)).length === 0, `4. ⛔ una cuenta de origen que no es nuestra no casa (${r4.estado})`);

      // 5. clave de rastreo repetida (la del caso 1, ahora para otro pago)
      leer({ monto: 333333.33, clave_rastreo: 'PGP130-RASTREO1' });
      const r5 = await comp.comprobanteDelCalendario('data:application/pdf;base64,AAAA', 'prueba_pgp130');
      ok(r5.estado === 'repetido' && (await filasCal(otroPago.id)).length === 0, `5. ⛔ la misma clave de rastreo en otro comprobante vivo (${r5.estado}), sin fila`);

      // 6. ilegible: no se sube nada
      const antes = subidas;
      leer({ ocr_status: 'ilegible', monto: null, fecha: null });
      const r6 = await comp.comprobanteDelCalendario('data:application/pdf;base64,AAAA', 'prueba_pgp130');
      ok(r6.estado === 'sin_lectura' && subidas === antes, `6. ⛔ un PDF ilegible no casa y no se sube (${r6.estado})`);

      // 7. el worker lo aplica
      const cal = Object.create(Calendario.prototype);
      Object.assign(cal, comunes(trx), { ledger: null });
      const a = await cal.pagarPorComprobante('prueba_pgp130');
      const p7 = await trx('finance.payment_allocations').where({ id: pago.id }).first();
      ok(a.pagados === 1 && p7.status === 'executed' && p7.paid_proof_id === r1.comprobante_id && p7.paid_validated_at != null,
        `7. queda pagado con su comprobante (${JSON.stringify({ pagados: a.pagados, status: p7.status })})`);
      const h7 = await trx('finance.payment_allocation_history').where({ allocation_id: pago.id });
      ok(h7.length === 1 && h7[0].event === 'pagado_por_comprobante' && h7[0].status_to === 'executed', '7. UNA fila «pagado_por_comprobante» en la bitácora');
      const a2 = await cal.pagarPorComprobante('prueba_pgp130');
      ok(a2.pagados === 0 && (await trx('finance.payment_allocation_history').where({ allocation_id: pago.id })).length === 1,
        '7. ⛔ correrlo otra vez no paga ni registra nada nuevo');

      // 8. la fila del worker de Kepler lo toma sin salida del banco
      const fila = (await trx.raw(sqlBanco.SQL_PROBADOS_SIN_LIGAR, [T, '2000-01-01', 5000])).rows.map((x) => x.id);
      ok(fila.includes(pago.id) && !fila.includes(otroPago.id), '8. la fila de Kepler toma el pago probado por comprobante (y no el pendiente)');

      // 9. el comprobante pasa al X-D-26
      const n9 = await porComprobante.moverComprobanteAKepler(trx, T, pago.id, { sucursal: '00', doc_prefix: 'XD2601', folio: '9913000' });
      const f9 = await trx('finance.supplier_payment_proofs').where({ id: r1.comprobante_id }).first();
      ok(n9 === 1 && f9.sucursal === '00' && f9.doc_prefix === 'XD2601' && f9.folio === '9913000', '9. al escribirse el X-D-26, el comprobante apunta a ese documento');

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
