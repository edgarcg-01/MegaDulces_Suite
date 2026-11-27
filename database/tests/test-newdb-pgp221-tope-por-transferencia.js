#!/usr/bin/env node
'use strict';
/**
 * [PGP.221] El banco no deja pasar una transferencia de más de su tope por operación (BBVA: $1,000,000.00) — servicio REAL
 * (ts-node) contra base real, todo dentro de una transacción que se revierte al final (cero efecto).
 *
 * El caso (Francisco, 2026-11-26): un pago de Effem de $1,020,891.81 salió de BBVA en dos SPEI ($1,000,000.00 + el resto)
 * sin estar partido en la Suite, y quedó en Kepler como UN documento por la suma. «La restricción en el banco BBVA es real,
 * es el tope por operación». Aquí las cifras son de prueba. Verifica, con el cuerpo que manda la pantalla:
 *   1. ⛔ preparar ENTERO un pago de BBVA de $1,020,891.81: 400 que dice en cuántas sale, y nada cambia;
 *   2. el borde: $1,000,000.00 exactos de BBVA sí se preparan;
 *   3. control: el mismo importe desde Santander (sin tope medido) se prepara;
 *   4. partido en $1,000,000.00 + $20,891.81 desde BBVA: se prepara, cada parte con su origen;
 *   5. ⛔ partido con una transferencia de BBVA de $1,500,000.00: 400 que nombra la transferencia 1, y nada cambia;
 *   6. partido con la de $1,500,000.00 desde Santander y el resto desde BBVA: se prepara;
 *   7. ⛔ autorizar un pago de BBVA ya preparado entero (antes de la regla, o le sumaron facturas): 400 y sigue sin autorizar;
 *      control: el mismo desde Santander no se detiene por el tope (se detiene después, por el tope de Presupuestos del día);
 *   8. ⛔ autorizar el DÍA con ese pago adentro: 400 y el día sigue en borrador;
 *   9. ⛔ un anticipo de BBVA de más de un millón: no se parte, así que el aviso pide otra cuenta de origen (al preparar y al
 *      autorizar).
 * Ningún caso deja un aviso inesperado en el log.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp221-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const avisos = [];
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
const migracion190 = require('../migrations-newdb/20261120202543_pgp190_pago_partido_en_transferencias.js');

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp221-tope-por-transferencia');

/** El servicio real con el saldo y los abonos de Kepler sustituidos (la base de pruebas no tiene Kepler). */
function servicio(trx, saldos) {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() { /* lo informativo no se mira */ }, warn(m) { avisos.push(String(m)); }, error(m) { avisos.push(String(m)); }, debug() { /* ídem */ } },
    tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
    tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
    ledger: null,
  });
  s.saldosDeKepler = async (_trx, ids) => new Map(ids.filter((id) => saldos.has(id)).map((id) => [id, saldos.get(id)]));
  s.abonosDeLasFacturas = async () => new Map();
  s.assertFacturasVigentes = async () => undefined;
  return s;
}

/** Una CLABE con su dígito de control bien puesto (la misma regla que `clabeValida`). */
function clabe(base17) {
  const pesos = [3, 7, 1];
  let suma = 0;
  for (let i = 0; i < 17; i++) suma += (Number(base17[i]) * pesos[i % 3]) % 10;
  return base17 + String((10 - (suma % 10)) % 10);
}

/** Lo que el servicio rechaza con 400, con su mensaje (null si no rechazó). */
async function rechazo(fn) {
  try { await fn(); return null; } catch (e) { return e?.status === 400 || e?.getStatus?.() === 400 ? String(e.message) : `NO-400: ${e?.message}`; }
}

(async () => {
  console.log('\n[PGP.221] El tope por operación del banco — servicio real, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      await migracion190.up(trx); // partir en transferencias necesita `split_from_id` (idempotente si ya está)

      const lote = async (fecha, extra = {}) => {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
        return (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha, ...extra }).returning('*'))[0];
      };
      const lDia = await lote('2099-08-20'), lAut = await lote('2099-08-21');
      const cuenta = async (bank, label) => (await trx('finance.bank_accounts').insert({ tenant_id: T, bank, account_label: label, kind: 'bank', active: true }).returning('id'))[0].id;
      const A = await cuenta('BBVA', 'PRUEBA-221-A'), B = await cuenta('BBVA', 'PRUEBA-221-B'), S = await cuenta('SANTANDER', 'PRUEBA-221-S');
      const CLABE = clabe('00218000123456789');
      const DESTINO = `CITI · CLABE ${CLABE}`;

      let k = 0;
      const ob = () => `00000000-0000-4000-8000-0000002210${String(++k).padStart(2, '0')}`;
      const saldos = new Map();
      /** Un pago de UNA factura de Kepler por `importe` (y lo que se le ponga ya preparado en `extra`). */
      const mk = async (lot, importe, extra = {}) => {
        const a = (await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: importe, created_by: 'smoke_pgp221', ...extra }).returning('*'))[0];
        const id = ob();
        saldos.set(id, { debe: importe, entity_ref: `oblig:08|20|1|${String(k).padStart(7, '0')}`, payee_code: 'CE012' });
        await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a.id, obligation_source: 'kepler_payable', obligation_id: id, applied_amount: importe });
        return a;
      };
      const s = servicio(trx, saldos);
      const fila = (id) => trx('finance.payment_allocations').where({ id }).first();
      const preparar = (a, origen) => s.prepare(a.id, { payment_method: 'transferencia', bank_account_id: origen, destination_account_text: DESTINO }, 'tesoreria_prueba');
      const cuerpo = (tr) => ({ destination_account_text: DESTINO, transferencias: tr.map(([amount, bank_account_id]) => ({ amount, bank_account_id })) });
      const nadaCambio = async (a, importe) => {
        const f = await fila(a.id);
        const partes = await trx('finance.payment_allocations').where({ split_from_id: a.id }).count({ n: '*' });
        return f.payment_method === null && f.bank_account_id === null && Number(f.amount_assigned) === importe && f.split_from_id === null && Number(partes[0].n) === 0;
      };

      // 1. Entero desde BBVA: no.
      const p1 = await mk(lDia, 1020891.81);
      const m1 = await rechazo(() => preparar(p1, A));
      ok(m1 === 'BBVA no deja pasar de $1,000,000.00 por transferencia y este pago es de $1,020,891.81: sale en 2 transferencias ($1,000,000.00 + $20,891.81). En «Preparar pago», márcalo «Sale en varias transferencias».'
        && await nadaCambio(p1, 1020891.81), `1. ⛔ entero desde BBVA: «${m1}» y nada cambia`);

      // 2. El borde: un millón exacto cabe.
      const p2 = await mk(lDia, 1000000);
      const m2 = await rechazo(() => preparar(p2, A));
      ok(m2 === null && (await fila(p2.id)).bank_account_id === A, `2. el borde: $1,000,000.00 exactos desde BBVA se preparan${m2 ? ` (rechazó: ${m2})` : ''}`);

      // 3. Control: Santander no tiene tope medido.
      const p3 = await mk(lDia, 1020891.81);
      const m3 = await rechazo(() => preparar(p3, S));
      ok(m3 === null && (await fila(p3.id)).payment_method === 'transferencia', `3. control: el mismo importe desde Santander se prepara${m3 ? ` (rechazó: ${m3})` : ''}`);

      // 4. Partido en el tope y el resto, desde BBVA: sí.
      const p4 = await mk(lDia, 1020891.81);
      const m4 = await rechazo(() => s.prepararEnTransferencias(p4.id, cuerpo([[1000000, A], [20891.81, B]]), 'tesoreria_prueba'));
      const g4 = await trx('finance.payment_allocations').where({ split_from_id: p4.id }).orderBy('created_at');
      ok(m4 === null && g4.length === 2 && g4.map((x) => `${Number(x.amount_assigned)}@${x.bank_account_id === A ? 'A' : x.bank_account_id === B ? 'B' : '?'}`).join(' ') === '1000000@A 20891.81@B'
        && g4.every((x) => x.payment_method === 'transferencia' && x.destination_account_text === DESTINO),
        `4. partido en $1,000,000.00 + $20,891.81 desde BBVA: dos pagos preparados, cada uno con su origen${m4 ? ` (rechazó: ${m4})` : ''}`);

      // 5. Una parte que pasa del tope: no, y nada cambia.
      const p5 = await mk(lDia, 2000000);
      const m5 = await rechazo(() => s.prepararEnTransferencias(p5.id, cuerpo([[1500000, A], [500000, B]]), 'tesoreria_prueba'));
      ok(m5 === 'La transferencia 1 es de $1,500,000.00 y sale de BBVA, que no deja pasar de $1,000,000.00 por operación: pártela en más transferencias.'
        && await nadaCambio(p5, 2000000), `5. ⛔ una transferencia de BBVA de $1,500,000.00: «${m5}» y nada cambia`);

      // 6. La grande desde Santander, el resto desde BBVA: sí.
      const p6 = await mk(lDia, 2000000);
      const m6 = await rechazo(() => s.prepararEnTransferencias(p6.id, cuerpo([[1500000, S], [500000, A]]), 'tesoreria_prueba'));
      ok(m6 === null, `6. $1,500,000.00 desde Santander y el resto desde BBVA: se prepara${m6 ? ` (rechazó: ${m6})` : ''}`);

      // 7. Autorizar un pago de BBVA ya preparado entero (escrito directo: se preparó antes de la regla).
      const yaPreparado = (origen) => ({ payment_method: 'transferencia', bank_account_id: origen, destination_account_text: DESTINO, priority_rank: 1 });
      const p7 = await mk(lAut, 1020891.81, yaPreparado(A));
      const m7 = await rechazo(() => s.authorize(p7.id, 'direccion_prueba'));
      ok(/^BBVA no deja pasar de \$1,000,000\.00 por transferencia y este pago es de \$1,020,891\.81/.test(m7 ?? '') && (await fila(p7.id)).authorized_at === null,
        `7. ⛔ autorizar entero desde BBVA: «${m7}» y sigue sin autorizar`);
      const p7s = await mk(lDia, 1020891.81, yaPreparado(S));
      const m7s = await rechazo(() => s.authorize(p7s.id, 'direccion_prueba'));
      ok(!!m7s && !/no deja pasar/.test(m7s) && !m7s.startsWith('NO-400'), `7. control: desde Santander no lo detiene el tope (lo detiene «${m7s}»)`);

      // 8. Autorizar el DÍA con ese pago adentro (el día tiene tope de Presupuestos de sobra).
      await trx('budget.daily_capacity').where({ tenant_id: T, capacity_date: '2099-08-21' }).del();
      await trx('budget.daily_capacity').insert({ tenant_id: T, capacity_date: '2099-08-21', authorized_amount: 50000000 });
      const m8 = await rechazo(() => s.releaseLot('2099-08-21', 'direccion_prueba'));
      const l8 = await trx('finance.payment_calendar_lots').where({ id: lAut.id }).first('status');
      ok(/^Un pago del día pasa del tope de su banco: BBVA no deja pasar/.test(m8 ?? '') && l8.status === 'draft', `8. ⛔ autorizar el día: «${m8}» y el día sigue en borrador`);

      // 9. Un anticipo de BBVA de más de un millón: no se parte → otra cuenta de origen.
      const prov = (await trx('catalog.suppliers').where({ tenant_id: T }).first('id'))?.id;
      if (prov) {
        const CLABE_ANT = clabe('01218000987654321');
        const acc = (await trx('commercial.supplier_payment_accounts').insert({ tenant_id: T, supplier_id: prov, bank_name: 'BBVA', clabe: CLABE_ANT, status: 'activa' }).returning('id'))[0].id;
        const ant = (await trx('commercial.supplier_payment_obligations').insert({ tenant_id: T, supplier_id: prov, original_amount: 1200000, authorized_by: 'direccion', nature: 'anticipo', payee_clabe: CLABE_ANT }).returning('id'))[0].id;
        const a9 = (await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lDia.id, classification: 'proveedor_mercancia', amount_assigned: 1200000, created_by: 'smoke_pgp221' }).returning('*'))[0];
        await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a9.id, obligation_source: 'supplier_payable', obligation_id: ant, applied_amount: 1200000 });
        const m9 = await rechazo(() => s.prepare(a9.id, { payment_method: 'transferencia', bank_account_id: A, supplier_payment_account_id: acc }, 'tesoreria_prueba'));
        const m9s = await rechazo(() => s.prepare(a9.id, { payment_method: 'transferencia', bank_account_id: S, supplier_payment_account_id: acc }, 'tesoreria_prueba'));
        ok(/este anticipo es de \$1,200,000\.00: un anticipo sale en una sola transferencia, así que elige una cuenta de origen de otro banco/.test(m9 ?? '') && m9s === null,
          `9. ⛔ un anticipo de BBVA: «${m9}»; desde Santander sí se prepara${m9s ? ` (rechazó: ${m9s})` : ''}`);
        await trx('finance.payment_allocations').where({ id: a9.id }).update({ bank_account_id: A, priority_rank: 1 });
        const m9a = await rechazo(() => s.authorize(a9.id, 'direccion_prueba'));
        ok(/anticipo sale en una sola transferencia/.test(m9a ?? ''), `9. ⛔ y al autorizarlo preparado desde BBVA: «${m9a}»`);
      } else {
        console.log('  ·  9. NO MEDIDO — la base de pruebas no tiene proveedores en el catálogo para sembrar un anticipo');
      }

      ok(avisos.length === 0, `ningún aviso inesperado en el log (${avisos.length})${avisos.length ? ': ' + avisos.join(' | ') : ''}`);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { fail++; console.log('  ✗ error:', e?.message ?? e); }
  } finally {
    await knex.destroy();
  }
  console.log(`\n  ${pass} ✓ · ${fail} ✗`);
  process.exit(fail ? 1 : 0);
})();
