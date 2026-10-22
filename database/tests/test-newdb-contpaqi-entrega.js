/* eslint-disable no-console */
/**
 * `[CP.8.52]` — Candado de **«Marcar como entregado»**, el primer endpoint del puente que ESCRIBE.
 *
 * ⛔⛔ Regla 13 de `CLAUDE.md`: un endpoint que escribe no está probado hasta que una prueba lo
 * ejerció contra una base REAL, con el payload de la pantalla. Este candado tiene dos modos según
 * contra qué base corre, y lo dice:
 *
 *   destino LOCAL (el job `pruebas-db` del CI, `localhost`) → **completo**: siembra un mes de
 *     prueba (2031-01) con `DATABASE_URL_NEW` (postgres), ejerce el servicio con el pool de
 *     `DATABASE_URL_NEW_RUNTIME` (`app_runtime`: RLS activo y sin tenant por default, igual que
 *     prod) usando el payload `{ mes, archivo_base64 }`, y limpia lo sembrado.
 *
 *   destino PROD → **sólo lectura**: el archivo de un mes real sale idéntico dos veces (sin eso,
 *     comparar byte a byte rechazaría todo) y un archivo alterado se rechaza ANTES de escribir.
 *     La escritura se declara NO MEDIDA: contra prod no se escribe desde una prueba.
 *
 * Lo que el modo completo exige:
 *   1. un archivo alterado en UN byte → `EntregaRechazada`, y cero filas;
 *   2. el archivo real → una fila `entregada` por póliza, con token, guid, autor y huella;
 *   3. marcar dos veces → cero nuevas, y `updated_at` intacto (el cuadre lo usa como reloj);
 *   4. ⛔ una póliza ya `aplicada` no vuelve a `entregada` al marcar de nuevo;
 *   5. el cuadre, como `app_runtime`, VE lo entregado (`[CP.8.58]`).
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
const MES = '2031-01';
const CAT = 'cp852_candado';
const POR = 'candado-cp852';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const silencio = { log() {}, warn() {}, error() {}, debug() {} };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.52 marcar entregado: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

function servicios(pool) {
  const { ContpaqiArmadoService, EntregaRechazada } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
  const { ContpaqiTxtSinkAdapter } = require(path.join(SRC, 'txt-sink.adapter.ts'));
  const { ContpaqiCuadreService } = require(path.join(SRC, 'contpaqi-cuadre.service.ts'));
  const armado = new ContpaqiArmadoService(pool, new ContpaqiTxtSinkAdapter());
  armado.log = silencio;
  const cuadre = new ContpaqiCuadreService(pool);
  cuadre.log = silencio;
  return { armado, cuadre, EntregaRechazada };
}

/** Un byte cambiado a mitad del archivo: lo mínimo que ya no es el mismo archivo. */
function alterado(b64) {
  const b = Buffer.from(b64, 'base64');
  const i = Math.floor(b.length / 2);
  b[i] = b[i] === 0x41 ? 0x42 : 0x41;
  return b.toString('base64');
}

async function soloLectura(url) {
  console.log('\n[modo SÓLO LECTURA — destino prod]');
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) },
  });
  try {
    const { armado, EntregaRechazada } = servicios(pool);
    const mes = '2026-01';
    const a = await armado.generarArchivoMes(mes);
    const b = await armado.generarArchivoMes(mes);
    check(a.contenido.length > 0, `${mes} genera ${a.polizas} pólizas (${a.contenido.length} caracteres)`);
    check(a.contenido === b.contenido, '⭐ generado dos veces, el archivo es IDÉNTICO — comparar byte a byte es posible');

    const antes = Number((await pool('contpaqi.poliza_exports').count({ n: '*' }).first()).n);
    let err = null;
    const real = Buffer.from(a.contenido, 'latin1').toString('base64');
    try { await armado.marcarEntregado(mes, alterado(real), POR); } catch (e) { err = e; }
    check(err instanceof EntregaRechazada, `un byte alterado → rechazada: «${String(err && err.message).slice(0, 80)}…»`);
    const despues = Number((await pool('contpaqi.poliza_exports').count({ n: '*' }).first()).n);
    check(antes === despues, `el rechazo no escribió (${antes} → ${despues})`);
    noMedido('el registro de la entrega: contra prod no se escribe desde una prueba — corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[modo COMPLETO — destino local]');
  assertSafeTarget('test-newdb-contpaqi-entrega', { url: urlAdmin });
  assertSafeTarget('test-newdb-contpaqi-entrega', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = {};
  try {
    if (!(await admin.schema.withSchema('contpaqi').hasTable('poliza_exports'))) {
      noMedido('contpaqi.poliza_exports no existe en este destino (la migración de [CP.8.1] no corrió)');
      return;
    }

    console.log('\n[0] Sembrar un mes de prueba con postgres (salta el RLS: siembra, no prueba)');
    const [cta] = await admin('finance.bank_accounts').insert({
      tenant_id: MEGA, bank: 'CANDADO', account_label: 'CP852', kind: 'bank', contpaqi_cuenta: '1020990000',
    }).returning('id');
    ids.cuenta = cta.id ?? cta;
    const [est] = await admin('finance.bank_statements').insert({
      tenant_id: MEGA, bank_account_id: ids.cuenta, period: MES,
    }).returning('id');
    ids.estado = est.id ?? est;
    const [cat] = await admin('finance.movement_categories').insert({
      tenant_id: MEGA, code: CAT, name: 'Candado CP.8.52', flow: 'out', group_key: 'candado',
    }).returning('id');
    ids.categoria = cat.id ?? cat;
    await admin('contpaqi.account_rules').insert({
      tenant_id: MEGA, categoria_code: CAT, tipo_regla: 'por_categoria', estado: 'aprobada',
      cuenta_gasto: '5200800000',
    });
    const movs = [['2031-01-10', 100.00], ['2031-01-10', 40.25], ['2031-01-11', 250.50]];
    for (const [i, [fecha, imp]] of movs.entries()) {
      await admin('finance.bank_movements').insert({
        tenant_id: MEGA, statement_id: ids.estado, bank_account_id: ids.cuenta, movement_date: fecha,
        client_uuid: `cp852-candado-${i}`, concept: `CANDADO CP852 ${i}`, amount_out: imp,
        category_id: ids.categoria,
      });
    }
    check(true, `sembrado: 1 cuenta · 1 categoría con regla aprobada · ${movs.length} egresos en ${MES}`);

    const { armado, cuadre, EntregaRechazada } = servicios(runtime);
    const arch = await armado.generarArchivoMes(MES);
    check(arch.polizas === 2, `el mes produce 2 pólizas (una por día de banco) — dio ${arch.polizas}`);
    // ⭐ El payload de la pantalla: los bytes del archivo en base64, sin pasar por texto.
    const payload = { mes: MES, archivo_base64: Buffer.from(arch.contenido, 'latin1').toString('base64') };
    const cuantas = async () => Number((await admin('contpaqi.poliza_exports')
      .where({ tenant_id: MEGA, periodo: MES }).count({ n: '*' }).first()).n);

    console.log('\n[1] Un archivo alterado se rechaza y no escribe');
    let err = null;
    try { await armado.marcarEntregado(payload.mes, alterado(payload.archivo_base64), POR); } catch (e) { err = e; }
    check(err instanceof EntregaRechazada, `rechazado: «${String(err && err.message).slice(0, 70)}…»`);
    check(await cuantas() === 0, 'cero filas tras el rechazo');

    console.log('\n[2] El archivo real se registra, como app_runtime');
    const r1 = await armado.marcarEntregado(payload.mes, payload.archivo_base64, POR);
    check(r1.nuevas === 2 && r1.ya_registradas === 0, `2 nuevas / 0 ya registradas — dio ${r1.nuevas} / ${r1.ya_registradas}`);
    const filas = await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).orderBy('evento_id');
    check(filas.every((f) => f.estado === 'entregada' && f.evento_tipo === 'bank_lote'), 'todas en `entregada`, tipo `bank_lote`');
    check(filas.every((f) => String(f.asiento.token || '').startsWith('MD:')), 'cada una lleva el token que el cuadre busca');
    check(filas.every((f) => f.asiento.entrega && f.asiento.entrega.por === POR
      && f.asiento.entrega.archivo_sha256 === r1.archivo_sha256), 'cada una lleva autor y huella del archivo');
    const suma = Math.round(filas.reduce((a, f) => a + Number(f.total), 0) * 100) / 100;
    check(suma === r1.total, `los totales registrados suman lo del archivo ($${suma} = $${r1.total})`);

    console.log('\n[3] Marcar dos veces no duplica ni reinicia el reloj');
    const relojAntes = filas.map((f) => String(f.updated_at));
    const r2 = await armado.marcarEntregado(payload.mes, payload.archivo_base64, POR);
    check(r2.nuevas === 0 && r2.ya_registradas === 2, `0 nuevas / 2 ya registradas — dio ${r2.nuevas} / ${r2.ya_registradas}`);
    const filas2 = await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).orderBy('evento_id');
    check(filas2.length === 2, `siguen siendo 2 filas (${filas2.length})`);
    check(filas2.every((f, i) => String(f.updated_at) === relojAntes[i]), '`updated_at` intacto: el plazo del cuadre no se reinicia');

    console.log('\n[4] ⛔ Una póliza ya aplicada no se degrada');
    await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, evento_id: filas2[0].evento_id })
      .update({ estado: 'aplicada', verificada: true });
    await armado.marcarEntregado(payload.mes, payload.archivo_base64, POR);
    const ap = await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, evento_id: filas2[0].evento_id }).first();
    check(ap.estado === 'aplicada', `sigue \`aplicada\` tras volver a marcar (está en \`${ap.estado}\`)`);

    console.log('\n[5] El cuadre, como app_runtime, ve lo entregado');
    const res = await cuadre.cuadrarPendientes('2031-01-12');
    check(res.total >= 1, `el cuadre juzga ${res.total} entrega(s) pendiente(s) — sin [CP.8.58] vería 0`);
  } finally {
    // Limpieza con postgres: lo sembrado y lo que el candado registró. Nada más.
    try {
      await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).del();
      await admin('contpaqi.account_rules').where({ tenant_id: MEGA, categoria_code: CAT }).del();
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
