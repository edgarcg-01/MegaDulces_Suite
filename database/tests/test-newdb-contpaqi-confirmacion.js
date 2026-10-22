/* eslint-disable no-console */
/**
 * `[CP.8.73]` — **Candado de «confirmar qué facturas paga un pago a proveedor».**
 *
 * ⛔ Regla 13: un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra una base real,
 * con el payload de la pantalla. Dos modos según el destino:
 *
 *   destino LOCAL (el job `pruebas-db` del CI) → **completo**: siembra con `DATABASE_URL_NEW` (postgres) un
 *     pago a proveedor que NO se arma solo (dos facturas que sólo juntas dan lo pagado, sin Kepler), y lo
 *     ejerce con el pool de `DATABASE_URL_NEW_RUNTIME` (`app_runtime`: RLS forzado y sin tenant por default,
 *     igual que prod) con el payload `{ facturas, notas }`. Limpia lo sembrado.
 *   destino PROD → **sólo lectura**: la lista de pagos por confirmar del mes cerrado; la escritura se declara
 *     NO MEDIDA (contra prod no se escribe desde una prueba).
 *
 * Lo que exige el modo completo:
 *   1. el pago aparece «por confirmar» con sus 2 facturas candidatas y la sugerencia por importe;
 *   2. ⛔ confirmar UNA sola factura (no da lo pagado) → `ConfirmacionRechazada` y cero filas;
 *   3. ⛔ confirmar una factura de OTRO proveedor → rechazada y cero filas;
 *   4. confirmar las dos → una fila vigente con autor, y el archivo del mes lleva la póliza del pago
 *      (`bank_pago_proveedor`) con sus 2 renglones `AD`;
 *   5. confirmar de nuevo reemplaza: 1 vigente, 2 en total;
 *   6. ⛔ sin tenant, `app_runtime` no ve ninguna confirmación (RLS);
 *   7. desconfirmar apaga la vigente; desconfirmar otra vez → rechazada.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
const ALIAS = {
  '@megadulces/contracts': path.join(ROOT, 'libs/contracts/src/index.ts'),
  '@megadulces/platform-core': path.join(ROOT, 'libs/platform-core/src/index.ts'),
};
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(pedido, ...resto) {
  return ALIAS[pedido] ? ALIAS[pedido] : resolveOriginal.call(this, pedido, ...resto);
};

const knexLib = require('knex');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { classify, assertSafeTarget } = require('./_lib/assert-safe-target');

const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'contpaqi');
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const MES = '2031-02';
const CAT = 'cp873_candado';
const POR = 'candado-cp873';
const RFC = 'CDC010101AA1';
const OTRO_RFC = 'OTR020202BB2';
const UUID_A = 'C873A000-0000-4000-8000-000000000001';
const UUID_B = 'C873B000-0000-4000-8000-000000000002';
const UUID_X = 'C873C000-0000-4000-8000-000000000003';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const silencio = { log() {}, warn() {}, error() {}, debug() {} };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.73 confirmar pago a proveedor: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

function servicios(pool) {
  const { ContpaqiArmadoService, ConfirmacionRechazada } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
  const { ContpaqiTxtSinkAdapter } = require(path.join(SRC, 'txt-sink.adapter.ts'));
  const armado = new ContpaqiArmadoService(pool, new ContpaqiTxtSinkAdapter());
  armado.log = silencio;
  return { armado, ConfirmacionRechazada };
}

async function soloLectura(url) {
  console.log('\n[modo SÓLO LECTURA — destino prod]');
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) },
  });
  try {
    const { armado } = servicios(pool);
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
    const mes = d.toISOString().slice(0, 7);
    const ps = await armado.pagosPorConfirmar(mes);
    check(Array.isArray(ps), `${mes}: ${ps.length} pagos a proveedor por confirmar`);
    const conPropuesta = ps.filter((p) => p.propuesta);
    check(conPropuesta.every((p) => /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(p.propuesta.rfc) && Array.isArray(p.propuesta.facturas)
      && p.propuesta.sugerencia.every((u) => p.propuesta.facturas.some((f) => f.uuid === u))),
    `${conPropuesta.length} con proveedor (RFC válido) y la sugerencia siempre DENTRO de sus candidatas`);
    check(ps.every((p) => p.motivo && p.movimiento_id), 'cada uno trae su motivo y su movimiento');
    noMedido('confirmar y desconfirmar: contra prod no se escribe desde una prueba — corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[modo COMPLETO — destino local]');
  assertSafeTarget('test-newdb-contpaqi-confirmacion', { url: urlAdmin });
  assertSafeTarget('test-newdb-contpaqi-confirmacion', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = {};
  try {
    if (!(await admin.schema.withSchema('contpaqi').hasTable('pago_confirmaciones'))) {
      noMedido('contpaqi.pago_confirmaciones no existe en este destino (la migración de [CP.8.73] no corrió)');
      return;
    }

    console.log('\n[0] Sembrar un pago a proveedor que no se arma solo (postgres: siembra, no prueba)');
    const [cta] = await admin('finance.bank_accounts').insert({
      tenant_id: MEGA, bank: 'CANDADO', account_label: 'CP873', kind: 'bank', contpaqi_cuenta: '1020990873',
    }).returning('id');
    ids.cuenta = cta.id ?? cta;
    const [est] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: ids.cuenta, period: MES }).returning('id');
    ids.estado = est.id ?? est;
    const [cat] = await admin('finance.movement_categories').insert({
      tenant_id: MEGA, code: CAT, name: 'Candado CP.8.73', flow: 'out', group_key: 'candado',
    }).returning('id');
    ids.categoria = cat.id ?? cat;
    await admin('contpaqi.account_rules').insert({
      tenant_id: MEGA, categoria_code: CAT, tipo_regla: 'por_proveedor', cuenta_prefijo: '2120', estado: 'derivada',
    });
    const [mov] = await admin('finance.bank_movements').insert({
      tenant_id: MEGA, statement_id: ids.estado, bank_account_id: ids.cuenta, movement_date: `${MES}-10`,
      client_uuid: 'cp873-candado-0', concept: 'PAGO DULCES DEL CANDADO', amount_out: 11600, category_id: ids.categoria,
    }).returning('id');
    ids.mov = mov.id ?? mov;
    const cfdi = (uuid, rfc, nombre, total, iva, s16) => ({
      tenant_id: MEGA, uuid, rol: 'recibidas', tipo_comprobante: 'I', emisor_rfc: rfc, emisor_nombre: nombre,
      fecha: `${MES}-01T12:00:00-06:00`, total, subtotal: total - iva, total_trasladados: iva, estatus_sat: 'vigente',
      source: 'candado_cp873', impuestos: JSON.stringify({ iva_trasladado: iva, ieps_trasladado: 0, subtotal_iva_16: s16 }),
    });
    await admin('fiscal.cfdis').insert([
      cfdi(UUID_A, RFC, 'DULCES DEL CANDADO SA DE CV', 6960, 960, 6000),
      cfdi(UUID_B, RFC, 'DULCES DEL CANDADO SA DE CV', 4640, 640, 4000),
      cfdi(UUID_X, OTRO_RFC, 'OTRO PROVEEDOR DEL CANDADO SA', 4640, 640, 4000),
    ]);
    await admin('finance.gl_supplier_accounts').insert({
      tenant_id: MEGA, supplier_name: 'DULCES DEL CANDADO', rfc: RFC, account_suffix: '999873', cuenta_proveedor: '2120999873',
    });
    check(true, 'sembrado: 1 cuenta · 1 categoría por proveedor · 1 egreso de $11,600 · 2 facturas que juntas lo dan · 1 ajena');

    const { armado, ConfirmacionRechazada } = servicios(runtime);
    const confs = async () => admin('contpaqi.pago_confirmaciones').where({ tenant_id: MEGA, bank_movement_id: ids.mov });

    console.log('\n[1] Aparece por confirmar, con sus candidatas y la sugerencia');
    const ps = await armado.pagosPorConfirmar(MES);
    const p = ps.find((x) => x.movimiento_id === String(ids.mov));
    check(!!p, `el pago aparece por confirmar (${ps.length} en el mes)`);
    check(!!p?.propuesta && p.propuesta.rfc === RFC, `proveedor identificado por el nombre del concepto: ${p?.propuesta?.rfc}`);
    const cand = new Set((p?.propuesta?.facturas ?? []).map((f) => f.uuid));
    check(cand.has(UUID_A) && cand.has(UUID_B) && !cand.has(UUID_X), 'candidatas: las 2 del proveedor, no la ajena');
    check((p?.propuesta?.sugerencia ?? []).length === 2 && p.propuesta.origen === 'importe', 'sugerencia: la combinación única por importe');

    console.log('\n[2] ⛔ Una sola factura no da lo pagado: rechazada, cero filas');
    let err = null;
    try { await armado.confirmarPago(String(ids.mov), [UUID_A], [], POR); } catch (e) { err = e; }
    check(err instanceof ConfirmacionRechazada, `rechazada: «${String(err && err.message).slice(0, 70)}…»`);
    check((await confs()).length === 0, 'cero filas tras el rechazo');

    console.log('\n[3] ⛔ Una factura de otro proveedor: rechazada, cero filas');
    err = null;
    try { await armado.confirmarPago(String(ids.mov), [UUID_A, UUID_X], [], POR); } catch (e) { err = e; }
    check(err instanceof ConfirmacionRechazada, `rechazada: «${String(err && err.message).slice(0, 70)}…»`);
    check((await confs()).length === 0, 'cero filas tras el rechazo');

    console.log('\n[4] Las dos facturas: se guarda y el archivo lleva el pago completo');
    const r = await armado.confirmarPago(String(ids.mov), [UUID_A, UUID_B], [], POR);
    check(r.total === 11600 && r.renglones >= 3, `armado: ${r.renglones} renglones, total ${r.total}`);
    const f1 = await confs();
    check(f1.length === 1 && f1[0].active && f1[0].confirmado_por === POR && Number(f1[0].pagado) === 11600,
      'una fila vigente, con autor y el importe al confirmar');
    const arch = await armado.generarArchivoMes(MES);
    const ad = arch.contenido.split('\r\n').filter((l) => l.startsWith('AD')).length;
    check(arch.polizas === 1, `el archivo del mes trae 1 póliza — dio ${arch.polizas}`);
    check(ad === 2 && arch.contenido.includes(UUID_A) && arch.contenido.includes(UUID_B), `con sus 2 renglones AD (${ad})`);
    check(arch.contenido.includes('2120999873') === false && arch.contenido.includes('5020999873'),
      'facturas del mismo mes y < $20 mil → compra directa 5020 del proveedor, no 2120');

    console.log('\n[5] Confirmar de nuevo reemplaza (apaga, no borra)');
    await armado.confirmarPago(String(ids.mov), [UUID_B, UUID_A], [], POR);
    const f2 = await confs();
    check(f2.length === 2 && f2.filter((f) => f.active).length === 1, `2 filas, 1 vigente — dio ${f2.length} / ${f2.filter((f) => f.active).length}`);

    console.log('\n[6] ⛔ Sin tenant, app_runtime no ve ninguna confirmación');
    const sinTenant = await runtime.transaction(async (trx) => trx('contpaqi.pago_confirmaciones').where({ bank_movement_id: ids.mov }));
    check(sinTenant.length === 0, `RLS: ${sinTenant.length} filas visibles sin tenant`);

    console.log('\n[7] Desconfirmar apaga la vigente; dos veces → rechazada');
    const d1 = await armado.desconfirmarPago(String(ids.mov), POR);
    check(d1.apagadas === 1 && (await confs()).every((f) => !f.active), 'apagada; ninguna vigente');
    err = null;
    try { await armado.desconfirmarPago(String(ids.mov), POR); } catch (e) { err = e; }
    check(err instanceof ConfirmacionRechazada, 'desconfirmar sin vigente → rechazada');
  } finally {
    try {
      if (ids.mov) await admin('contpaqi.pago_confirmaciones').where({ tenant_id: MEGA, bank_movement_id: ids.mov }).del();
      await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).del();
      await admin('contpaqi.account_rules').where({ tenant_id: MEGA, categoria_code: CAT }).del();
      await admin('fiscal.cfdis').where({ tenant_id: MEGA, source: 'candado_cp873' }).del();
      await admin('finance.gl_supplier_accounts').where({ tenant_id: MEGA, account_suffix: '999873' }).del();
      if (ids.cuenta) await admin('finance.bank_accounts').where({ id: ids.cuenta }).del(); // cascada: estado y movimientos
      if (ids.categoria) await admin('finance.movement_categories').where({ id: ids.categoria }).del();
    } catch (e) {
      console.log(`  ⚠ limpieza incompleta: ${e.message}`);
    }
    await admin.destroy();
    await runtime.destroy();
  }
}

(async () => {
  const urlAdmin = process.env.DATABASE_URL_NEW;
  const urlRuntime = process.env.DATABASE_URL_NEW_RUNTIME;
  const kAdmin = classify(urlAdmin).kind;
  const kRuntime = classify(urlRuntime).kind;
  if (kAdmin === 'local' && kRuntime === 'local') await completo(urlAdmin, urlRuntime);
  else if (kAdmin === 'prod') await soloLectura(urlAdmin);
  else noMedido(`destino ${kAdmin}/${kRuntime}: ni local ni prod — no se corre`);
  fin();
})().catch((e) => {
  console.log(`  ✗ excepción: ${e && e.message}`);
  fail += 1;
  fin();
});
