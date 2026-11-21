#!/usr/bin/env node
'use strict';
/**
 * [PGP.190] Un pago que sale en varias transferencias se parte en un pago por transferencia — servicio REAL (ts-node) y
 * migración REAL contra base real, todo dentro de una transacción que se revierte al final (cero efecto).
 *
 * El pedido (Francisco, 2026-11-20): «hay pagos que se hacen con varias transferencias». Forma tomada de Kepler: CE012
 * 31-ago, una factura abonada con dos X-D-26 (un millón y el resto). Aquí las cifras son de prueba. ⚠️ El saldo y los abonos de
 * Kepler (`saldosDeKepler`, `abonosDeLasFacturas`) son un DOBLE, como en la prueba de PGP.148: la base de pruebas no
 * tiene Kepler. Lo que se prueba es lo que ESCRIBE, con el cuerpo que manda la pantalla. Verifica:
 *   0. la migración `pgp190` corre (y otra vez, idempotente) y deja la columna;
 *   1. una factura en dos transferencias: el original se queda con la 1ª, nace la 2ª en el mismo día, la factura queda
 *      abonada en dos renglones que suman lo de antes, cada parte preparada con SU origen y la misma CLABE, las dos en el
 *      mismo grupo y con su bitácora;
 *   2. varias facturas: llenan la 1ª en orden y sólo la de la frontera se parte; la que no cruza se MUEVE (mismo renglón);
 *   3. tres transferencias: «1 de 3, 2 de 3, 3 de 3» en el orden escrito;
 *   4. ⛔ la factura con descuento en la frontera: 400 que dice a cuánto dejarla, y nada cambia;
 *   5. ⛔ importes que no suman el pago, sin origen, pago autorizado o día autorizado: 400 y nada cambia;
 *   6. ⛔ un origen inválido en la 2ª: el reparto entero se deshace (todo o nada);
 *   7. ⛔ un anticipo no se parte;
 *   8. una nota de crédito de $50,000 a la factura partida: el worker baja la ÚLTIMA parte a $25,000.50 y no toca la 1ª
 *      (la suma queda en lo que se debe); antes cada parte se comparaba contra el saldo entero y no veía nada;
 *   9. una nota mayor que la última parte: la 1ª baja y la última se omite con el motivo (se quita del pago, no baja a 0);
 *  10. reprogramar una parte la deja en su grupo;
 *  11. preparar un pago normal (sin partir) sigue igual tras separar `prepareEn`.
 * Ningún caso deja un aviso inesperado en el log.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp190-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const avisos = [];
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let Servicio, D, P;
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
  P = require(path.join(__dirname, '../../libs/finance/src/lib/payment-calendar/partir-en-transferencias.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}
const migracion = require('../migrations-newdb/20261120202543_pgp190_pago_partido_en_transferencias.js');

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp190-partir-en-transferencias');

/** El servicio real con el saldo y los abonos de Kepler sustituidos (la base de pruebas no tiene Kepler). */
function servicio(trx, saldos, abonos) {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() { /* lo informativo no se mira */ }, warn(m) { avisos.push(String(m)); }, error(m) { avisos.push(String(m)); }, debug() { /* ídem */ } },
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
  console.log('\n[PGP.190] Partir un pago en varias transferencias — servicio y migración reales, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      // 0. La migración real, dos veces.
      await migracion.up(trx);
      await migracion.up(trx);
      ok(await trx.schema.withSchema('finance').hasColumn('payment_allocations', 'split_from_id'), '0. la migración deja `split_from_id` (y otra vez no truena: idempotente)');

      const HOY = '2099-07-10';
      const lote = async (fecha, extra = {}) => {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
        return (await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha, ...extra }).returning('*'))[0];
      };
      const lFuturo = await lote('2099-07-20'), lCerrado = await lote('2099-07-21', { status: 'released' }), lOtro = await lote('2099-07-22');
      const cuenta = async (label, active = true) => (await trx('finance.bank_accounts').insert({ tenant_id: T, bank: 'BBVA', account_label: label, kind: 'bank', active }).returning('id'))[0].id;
      const A = await cuenta('PRUEBA-190-A'), B = await cuenta('PRUEBA-190-B'), C = await cuenta('PRUEBA-190-C'), MUERTA = await cuenta('PRUEBA-190-X', false);
      const CLABE = clabe('01218000123456789');
      const DESTINO = `BBVA · CLABE ${CLABE}`;

      let k = 0;
      const ob = () => `00000000-0000-4000-8000-0000001900${String(++k).padStart(2, '0')}`;
      const saldos = new Map(), abonos = new Map();
      /** Un pago con sus facturas de Kepler: [{ aplicado, debe, folio, descuento }]. */
      const mk = async (lot, facturas, extra = {}) => {
        const total = Math.round(facturas.reduce((s, f) => s + f.aplicado, 0) * 100) / 100;
        const a = (await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: total, created_by: 'smoke_pgp190', ...extra }).returning('*'))[0];
        const its = [];
        for (const f of facturas) {
          const id = ob();
          saldos.set(id, { debe: f.debe ?? f.aplicado, entity_ref: `oblig:00|20|1|${f.folio}`, payee_code: 'CE012' });
          its.push((await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a.id, obligation_source: 'kepler_payable', obligation_id: id,
            applied_amount: f.aplicado, discount_amount: f.descuento ?? 0, discount_reason: f.descuento ? 'pronto_pago' : null,
            created_at: trx.raw(`clock_timestamp()`) }).returning('*'))[0]);
        }
        return { a, its };
      };
      const s = servicio(trx, saldos, abonos);
      const fila = (id) => trx('finance.payment_allocations').where({ id }).first();
      const renglones = (allocationId) => trx('finance.payment_allocation_items').where({ allocation_id: allocationId }).orderBy('created_at');
      const delGrupo = (grupo) => trx('finance.payment_allocations').where({ split_from_id: grupo }).whereNot({ status: 'cancelled' }).orderBy('created_at');
      const cuerpo = (tr) => ({ destination_account_text: DESTINO, transferencias: tr.map(([amount, bank_account_id]) => ({ amount, bank_account_id })) });

      // 1. Una factura en dos transferencias.
      const c1 = await mk(lFuturo, [{ aplicado: 1075000.5, folio: '0000101' }]);
      const r1 = await s.prepararEnTransferencias(c1.a.id, cuerpo([[1000000, A], [75000.5, B]]), 'tesoreria_prueba');
      const [p1, p2] = await delGrupo(c1.a.id);
      const i1 = await renglones(p1?.id), i2 = await renglones(p2?.id);
      ok(r1.original === c1.a.id && r1.partes.length === 2 && r1.partes[0].id === c1.a.id && r1.partes.map((p) => p.amount_assigned).join('+') === '1000000+75000.5',
        `1. la respuesta: el original es la 1ª, ${r1.partes.map((p) => `${p.parte} de ${p.de}`).join(', ')}`);
      ok(p1?.id === c1.a.id && Number(p1.amount_assigned) === 1000000 && Number(p2?.amount_assigned) === 75000.5 && p2.lot_id === lFuturo.id,
        '1. el original se queda con $1,000,000.00 y la 2ª nace en el MISMO día por $75,000.50');
      ok(i1.length === 1 && i2.length === 1 && i1[0].obligation_id === i2[0].obligation_id && Number(i1[0].applied_amount) + Number(i2[0].applied_amount) === 1075000.5,
        '1. la factura queda abonada en dos renglones que suman lo de antes (como los dos X-D-26 de CE012)');
      ok(p1.payment_method === 'transferencia' && p1.bank_account_id === A && p2.payment_method === 'transferencia' && p2.bank_account_id === B
        && p1.destination_account_text === DESTINO && p2.destination_account_text === DESTINO,
        '1. cada parte queda preparada: transferencia, SU cuenta de origen y la misma CLABE destino');
      ok(p1.split_from_id === c1.a.id && p2.split_from_id === c1.a.id, '1. las dos en el grupo del pago original');
      const h1 = await trx('finance.payment_allocation_history').whereIn('allocation_id', [p1.id, p2.id]).where({ event: P.EVENTO_PARTIDO_EN_TRANSFERENCIAS });
      ok(h1.length === 2 && h1.every((h) => h.created_by === 'tesoreria_prueba'), '1. una fila de bitácora en cada parte, con quién lo partió');
      const tdes = await s.transferenciasDe(trx, T, [p1, p2]);
      ok(tdes.get(p1.id)?.parte === 1 && tdes.get(p2.id)?.parte === 2 && tdes.get(p2.id)?.de === 2, '1. el renglón del día dice «transferencia 1 de 2» y «2 de 2»');

      // 2. Varias facturas: sólo la de la frontera se parte; la que no cruza se mueve (el mismo renglón).
      const c2 = await mk(lOtro, [{ aplicado: 600000, folio: '000A' }, { aplicado: 500000, folio: '000B' }, { aplicado: 50000.25, folio: '000C' }]);
      await s.prepararEnTransferencias(c2.a.id, cuerpo([[1000000, A], [150000.25, B]]), 'tesoreria_prueba');
      const [q1, q2] = await delGrupo(c2.a.id);
      const j1 = await renglones(q1.id), j2 = await renglones(q2.id);
      const folioDe = (it) => c2.its.findIndex((x) => x.obligation_id === it.obligation_id);
      ok(j1.map((x) => `${folioDe(x)}:${Number(x.applied_amount)}`).join(' ') === '0:600000 1:400000'
        && j2.map((x) => `${folioDe(x)}:${Number(x.applied_amount)}`).join(' ') === '1:100000 2:50000.25',
        '2. la 1ª lleva A ($600,000) y parte de B ($400,000); la 2ª el resto de B ($100,000) y C entera');
      ok(j2.some((x) => x.id === c2.its[2].id), '2. la factura que no cruza se MUEVE (el mismo renglón), no se copia');

      // 3. Tres transferencias, en el orden escrito.
      const c3 = await mk(lOtro, [{ aplicado: 900, folio: '0003' }]);
      await s.prepararEnTransferencias(c3.a.id, cuerpo([[100, A], [200, B], [600, C]]), 'tesoreria_prueba');
      const g3 = await delGrupo(c3.a.id);
      const t3 = await s.transferenciasDe(trx, T, g3);
      ok(g3.map((x) => `${t3.get(x.id)?.parte} de ${t3.get(x.id)?.de}: ${Number(x.amount_assigned)} ${x.bank_account_id === [A, B, C][t3.get(x.id).parte - 1] ? 'ok' : 'MAL'}`).join(' | ')
        === '1 de 3: 100 ok | 2 de 3: 200 ok | 3 de 3: 600 ok', '3. tres transferencias: «1 de 3, 2 de 3, 3 de 3» en el orden escrito, cada una con su origen');

      // 4–7. Lo que se rechaza, y que nada cambie.
      const sinCambio = async (pago, total, n) => {
        const f = await fila(pago.a.id);
        const its = await renglones(pago.a.id);
        const nuevos = await trx('finance.payment_allocations').where({ lot_id: f.lot_id, created_by: 'tesoreria_prueba' }).whereNull('split_from_id').count({ n: '*' });
        return Number(f.amount_assigned) === total && its.length === n && f.split_from_id === null && f.payment_method === null && Number(nuevos[0].n) === 0;
      };
      const c4 = await mk(lOtro, [{ aplicado: 100, folio: '04A' }, { aplicado: 500, descuento: 25, folio: '04B' }, { aplicado: 200, folio: '04C' }]);
      const m4 = await rechazo(() => s.prepararEnTransferencias(c4.a.id, cuerpo([[300, A], [500, B]]), 'tesoreria_prueba'));
      ok(/20-1-04B lleva descuento al pagar.*en \$100\.00 o en \$600\.00/.test(m4 ?? '') && await sinCambio(c4, 800, 3),
        `4. ⛔ la factura con descuento en la frontera: «${m4}» y nada cambia`);
      const c5 = await mk(lOtro, [{ aplicado: 1000, folio: '0005' }]);
      const m5a = await rechazo(() => s.prepararEnTransferencias(c5.a.id, cuerpo([[600, A], [300, B]]), 'tesoreria_prueba'));
      const m5b = await rechazo(() => s.prepararEnTransferencias(c5.a.id, cuerpo([[600, A], [400, '']]), 'tesoreria_prueba'));
      ok(/suman \$900\.00 y el pago es de \$1,000\.00/.test(m5a ?? '') && /cuenta de origen de cada/.test(m5b ?? '') && await sinCambio(c5, 1000, 1),
        '5. ⛔ importes que no suman el pago y una transferencia sin origen: 400 y nada cambia');
      const c5c = await mk(lOtro, [{ aplicado: 1000, folio: '005C' }], { authorized_at: trx.fn.now(), authorized_by: 'direccion' });
      const c5d = await mk(lCerrado, [{ aplicado: 1000, folio: '005D' }]);
      const m5c = await rechazo(() => s.prepararEnTransferencias(c5c.a.id, cuerpo([[600, A], [400, B]]), 'tesoreria_prueba'));
      const m5d = await rechazo(() => s.prepararEnTransferencias(c5d.a.id, cuerpo([[600, A], [400, B]]), 'tesoreria_prueba'));
      ok(!!m5c && !m5c.startsWith('NO-400') && /autorizado/.test(m5d ?? ''), `5. ⛔ pago autorizado («${m5c}») y día autorizado («${m5d}»): no se parten`);
      const c6 = await mk(lOtro, [{ aplicado: 1000, folio: '0006' }]);
      const m6 = await rechazo(() => s.prepararEnTransferencias(c6.a.id, cuerpo([[600, A], [400, MUERTA]]), 'tesoreria_prueba'));
      ok(/origen no existe o está inactiva/.test(m6 ?? '') && await sinCambio(c6, 1000, 1), `6. ⛔ un origen inválido en la 2ª deshace TODO el reparto («${m6}»)`);
      const prov = (await trx('catalog.suppliers').where({ tenant_id: T }).first('id'))?.id;
      if (prov) {
        const ant = (await trx('commercial.supplier_payment_obligations').insert({ tenant_id: T, supplier_id: prov, original_amount: 1000, authorized_by: 'direccion', nature: 'anticipo' }).returning('id'))[0].id;
        const a7 = (await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lOtro.id, classification: 'proveedor_mercancia', amount_assigned: 1000, created_by: 'smoke_pgp190' }).returning('*'))[0];
        await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: a7.id, obligation_source: 'supplier_payable', obligation_id: ant, applied_amount: 1000 });
        const m7 = await rechazo(() => s.prepararEnTransferencias(a7.id, cuerpo([[600, A], [400, B]]), 'tesoreria_prueba'));
        ok(/anticipo no se parte/.test(m7 ?? ''), `7. ⛔ un anticipo no se parte («${m7}»)`);
      } else {
        console.log('  ·  7. NO MEDIDO — la base de pruebas no tiene proveedores en el catálogo para sembrar un anticipo');
      }

      // 8. Una nota de crédito de $50,000 a la factura partida del caso 1 (las dos partes, día por venir).
      const ob1 = i1[0].obligation_id;
      saldos.set(ob1, { debe: 1025000.5, entity_ref: 'oblig:00|20|1|0000101', payee_code: 'CE012' });
      abonos.set('00|20|1|0000101', [{ doc: '55-0019990', clase: 'Nota de crédito', fecha: '2099-07-05', monto: 50000 }]);
      const w8 = await s.ajustarLosQueDebenMenos(HOY);
      const [r8a, r8b] = [await renglones(p1.id), await renglones(p2.id)];
      ok(Number(r8a[0].applied_amount) === 1000000 && Number(r8b[0].applied_amount) === 25000.5 && w8.ajustados.length === 1 && w8.ajustados[0] === p2.id,
        `8. una nota de $50,000: el worker baja la ÚLTIMA parte a $25,000.50 y no toca la 1ª (ajustados ${w8.ajustados.length}, fallidos ${w8.fallidos})`);
      ok(Number(r8a[0].applied_amount) + Number(r8b[0].applied_amount) === 1025000.5, '8. la suma de las partes queda en lo que se debe');
      const viejo = D.facturasQueDebenMenos([
        { id: 'x', applied_amount: 1000000, kepler_debe: 1025000.5, kepler_saldada: false, entity_ref: null, payee_code: null },
        { id: 'y', applied_amount: 75000.5, kepler_debe: 1025000.5, kepler_saldada: false, entity_ref: null, payee_code: null }]);
      ok(viejo.length === 0, '8. NEGATIVA: comparar cada parte contra el saldo entero (lo de antes) no veía los $50,000');

      // 9. Una nota mayor que la última parte (saldo de la factura 2 del caso 2 baja a $350,000: las partes llevan 400k + 100k).
      const obB = c2.its[1].obligation_id;
      saldos.set(obB, { debe: 350000, entity_ref: 'oblig:00|20|1|000B', payee_code: 'CE012' });
      abonos.set('00|20|1|000B', [{ doc: '55-0019991', clase: 'Nota de crédito', fecha: '2099-07-05', monto: 150000 }]);
      const r9a = await s.ajustarAlSaldoEn(trx, T, q1.id, 'tesoreria_prueba', 'manual', HOY);
      const r9b = await s.ajustarAlSaldoEn(trx, T, q2.id, 'tesoreria_prueba', 'manual', HOY);
      const bEn1 = (await renglones(q1.id)).find((x) => x.obligation_id === obB), bEn2 = (await renglones(q2.id)).find((x) => x.obligation_id === obB);
      ok(Number(bEn1.applied_amount) === 350000 && r9a.ajustadas.length === 1, '9. una nota mayor que la última parte: la 1ª baja a lo que se debe ($350,000)');
      ok(Number(bEn2.applied_amount) === 100000 && r9b.ajustadas.length === 0 && r9b.omitidas.some((o) => o.motivo === D.MOTIVO_CUBIERTA_POR_OTRA_PARTE),
        '9. la última no baja a $0: se omite con «quítala de este pago»');

      // 10. Reprogramar una parte la deja en su grupo.
      const mov = await s.reprogram(g3[1].id, '2099-07-25', 'otro', 'prueba', 'tesoreria_prueba', HOY);
      const g10 = await delGrupo(c3.a.id);
      const t10 = await s.transferenciasDe(trx, T, g10);
      ok(mov.split_from_id === c3.a.id && g10.length === 3 && t10.get(mov.id)?.de === 3, '10. la transferencia reprogramada sigue en su grupo (3 partes vivas)');

      // 11. Preparar un pago normal sigue igual (prepare → prepareEn).
      const c11 = await mk(lOtro, [{ aplicado: 777, folio: '0011' }]);
      await s.prepare(c11.a.id, { payment_method: 'transferencia', bank_account_id: A, destination_account_text: DESTINO }, 'tesoreria_prueba');
      const f11 = await fila(c11.a.id);
      ok(f11.payment_method === 'transferencia' && f11.bank_account_id === A && f11.destination_account_text === DESTINO && f11.split_from_id === null,
        '11. preparar un pago sin partir sigue igual');

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
