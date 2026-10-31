/* eslint-disable no-console */
/**
 * `[CP.8.88]` + `[CP.8.95]` — Candado de **lo que el dictamen frena**: una póliza que contabilidad ya capturó no sale
 * en el archivo (entregarla la DUPLICARÍA en ContPAQi), sin override, y la pantalla ve lo mismo que el archivo.
 *
 * Dos partes, según contra qué base corre:
 *
 *   [B] contra PROD, sólo lectura: septiembre de 2026, que contabilidad ya capturó entero. El dictamen tiene que
 *       frenar casi todo por `ya_capturada`, y el archivo no puede llevar ninguna de las que frena.
 *   [C] contra destino LOCAL (job `pruebas-db`), escribiendo como `app_runtime`: un mes sintético con dos días de
 *       banco. Sin póliza de ella salen las dos (control); con su póliza del primer día, ése se frena y se declara;
 *       con otro importe ya no se frena (el cruce es por cuenta de banco e importe, no por día); y lo frenado nunca
 *       se registra como entregado. Limpia lo sembrado.
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
const MES = '2001-03';
const CAT = 'cp888_candado';
const GASTO = '5299990002';
const BANCO = '1020990002';
const POR = 'candado-cp888';
const FOLIO = '88801';
const MES_REAL = '2026-09';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const silencio = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.88 lo que el dictamen frena no sale: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

function servicio(pool) {
  const { ContpaqiArmadoService } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
  const { ContpaqiTxtSinkAdapter } = require(path.join(SRC, 'txt-sink.adapter.ts'));
  const armado = new ContpaqiArmadoService(pool, new ContpaqiTxtSinkAdapter());
  armado.log = silencio;
  return armado;
}

async function soloLectura(url) {
  console.log(`\n[B] Contra prod, sólo lectura: ${MES_REAL}, que contabilidad ya capturó`);
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query("SET default_transaction_read_only = on; SET app.tenant_id = ''", (e) => d(e, c)) },
  });
  try {
    const armado = servicio(pool);
    const t0 = Date.now();
    const dic = await armado.dictamenDelMes(MES_REAL);
    const ms = Date.now() - t0;
    const frenadas = dic.polizas.filter((p) => p.veredicto === 'bloqueada');
    const yaCapturadas = frenadas.filter((p) => p.hallazgos.some((x) => x.regla === 'ya_capturada'));
    console.log(`    ${dic.polizas.length} pólizas por entregar · ${frenadas.length} bloqueadas (${yaCapturadas.length} ya capturadas)`
      + ` · ${dic.resumen.por_veredicto.revisar} a revisar · ${dic.resumen.por_veredicto.lista} listas · ${ms} ms`);
    check(dic.polizas.length > 50, `el dictamen juzga lo que saldría en ${MES_REAL} como app_runtime: ${dic.polizas.length} pólizas`);
    check(yaCapturadas.length >= dic.polizas.length * 0.9,
      `⭐ frena por «ya capturada» casi todo un mes que ella ya capturó: ${yaCapturadas.length} de ${dic.polizas.length}`);
    check(frenadas.every((p) => p.hallazgos.some((x) => x.severidad === 'bloquea')), 'cada bloqueada dice qué regla la frena');

    let arch = null;
    let err = null;
    try { arch = await armado.generarArchivoMes(MES_REAL); } catch (e) { err = e; }
    if (arch) {
      const enArchivo = new Set(arch.bloqueadas.map((b) => `${b.evento_tipo}|${b.clave}`));
      check(arch.bloqueadas.length === frenadas.length,
        `el archivo deja fuera las mismas que la pantalla dice bloqueadas (${arch.bloqueadas.length} = ${frenadas.length})`);
      check(frenadas.every((p) => enArchivo.has(`${p.evento_tipo}|${p.clave}`)), 'una por una, las mismas');
      check(arch.polizas + arch.bloqueadas.length === dic.polizas.length,
        `lo que sale más lo frenado es todo lo pendiente (${arch.polizas} + ${arch.bloqueadas.length} = ${dic.polizas.length})`);
    } else {
      check(/lo frena el dictamen/.test(String(err && err.message)) && frenadas.length === dic.polizas.length,
        `todo lo pendiente está frenado: el archivo no se genera y dice por qué («${String(err && err.message).slice(0, 90)}…»)`);
    }
    noMedido('excluir y registrar: contra prod no se escribe desde una prueba — corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[C] Contra destino local, escribiendo como app_runtime');
  assertSafeTarget('test-newdb-contpaqi-candado-duplicado', { url: urlAdmin });
  assertSafeTarget('test-newdb-contpaqi-candado-duplicado', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = {};
  const suPoliza = { tenant_id: MEGA, source: 'contpaqi', ejercicio: 2001, periodo: 3, tipo_pol: '2', folio: FOLIO };
  try {
    for (const [s, t] of [['contpaqi', 'account_rules'], ['contpaqi', 'poliza_exports'], ['analytics', 'contpaqi_accounts'], ['analytics', 'gl_polizas']]) {
      if (!(await admin.schema.withSchema(s).hasTable(t))) { noMedido(`${s}.${t} no existe en este destino`); return; }
    }
    // Siembra con postgres (salta el RLS: siembra, no prueba).
    await admin('analytics.contpaqi_accounts').insert([[GASTO, 'CANDADO GASTO CP888', 'G'], [BANCO, 'CANDADO BANCO CP888', 'A']]
      .map(([codigo, nombre, tipo]) => ({ tenant_id: MEGA, codigo, nombre, tipo, es_baja: false, afectable: 1 })));
    const [cta] = await admin('finance.bank_accounts').insert({ tenant_id: MEGA, bank: 'CANDADO', account_label: 'CP888', kind: 'bank', contpaqi_cuenta: BANCO }).returning('id');
    ids.cuenta = cta.id ?? cta;
    const [est] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: ids.cuenta, period: MES }).returning('id');
    const [cat] = await admin('finance.movement_categories').insert({ tenant_id: MEGA, code: CAT, name: 'Candado CP.8.88', flow: 'out', group_key: 'candado' }).returning('id');
    ids.categoria = cat.id ?? cat;
    await admin('contpaqi.account_rules').insert({ tenant_id: MEGA, categoria_code: CAT, tipo_regla: 'por_categoria', estado: 'aprobada', cuenta_gasto: GASTO });
    for (const [i, fecha, imp] of [[0, '2001-03-05', 100.00], [1, '2001-03-06', 250.50]]) {
      await admin('finance.bank_movements').insert({
        tenant_id: MEGA, statement_id: est.id ?? est, bank_account_id: ids.cuenta, movement_date: fecha,
        client_uuid: `cp888-candado-${i}`, concept: `CANDADO CP888 ${i}`, amount_out: imp, category_id: ids.categoria,
      });
    }
    // La póliza de ella: egreso (tipo 2) con la misma cuenta de banco e importe que el lote del día 5.
    const ponerSuPoliza = async (importe) => {
      await admin('analytics.gl_poliza_lines').where(suPoliza).del();
      await admin('analytics.gl_polizas').where(suPoliza).del();
      await admin('analytics.gl_polizas').insert({ ...suPoliza, anio_mes: MES, fecha: '2001-03-05', concepto: 'CANDADO CP888 DE ELLA', cargos: importe, abonos: importe, num_lines: 2 });
      await admin('analytics.gl_poliza_lines').insert([[1, GASTO, 'C'], [2, BANCO, 'A']]
        .map(([num_movto, cuenta, cargo_abono]) => ({ ...suPoliza, num_movto, cuenta, cargo_abono, importe, anio_mes: MES })));
    };
    check(true, 'sembrado: cuentas en el catálogo, una regla firmada, 2 egresos en 2 días');

    const armado = servicio(runtime);
    const a0 = await armado.generarArchivoMes(MES);
    check(a0.polizas === 2 && a0.bloqueadas.length === 0, `control: sin póliza de ella salen las 2 y no se frena ninguna (${a0.polizas} · ${a0.bloqueadas.length})`);

    await ponerSuPoliza(100.00);
    const a1 = await armado.generarArchivoMes(MES);
    const b1 = a1.bloqueadas[0];
    check(a1.polizas === 1 && a1.bloqueadas.length === 1, `⭐ con su póliza del día 5, ese lote se frena: ${a1.polizas} sale · ${a1.bloqueadas.length} frenada`);
    check(b1 && b1.clave === `${BANCO}|2001-03-05` && b1.reglas.includes('ya_capturada') && /ya la capturó/.test(b1.motivo),
      `y se declara con su motivo: ${b1 ? `${b1.clave} · ${b1.reglas.join(',')}` : 'sin bloqueada'}`);
    const d1 = await armado.dictamenDelMes(MES);
    const v1 = Object.fromEntries(d1.polizas.map((p) => [p.clave, p.veredicto]));
    check(v1[`${BANCO}|2001-03-05`] === 'bloqueada' && v1[`${BANCO}|2001-03-06`] !== 'bloqueada' && d1.resumen.por_veredicto.bloqueada === 1,
      `la pantalla ve lo mismo que el archivo: ${JSON.stringify(v1)}`);

    const b64 = Buffer.from(a1.contenido, 'latin1').toString('base64');
    const m1 = await armado.marcarEntregado(MES, b64, POR);
    const filas = await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).pluck('evento_id');
    check(m1.nuevas === 1 && filas.length === 1 && filas[0] === `${BANCO}|2001-03-06`,
      `⛔ lo frenado nunca se registra como entregado: ${filas.join(', ') || 'nada'}`);
    const d2 = await armado.dictamenDelMes(MES);
    check(d2.polizas.length === 1 && d2.polizas[0].clave === `${BANCO}|2001-03-05` && d2.ya_entregadas === 1,
      `lo ya entregado sale de la pantalla como sale del archivo: juzga ${d2.polizas.map((p) => p.clave).join(', ')} · ${d2.ya_entregadas} entregada`);

    await ponerSuPoliza(100.01);
    const a2 = await armado.generarArchivoMes(MES);
    check(a2.polizas === 1 && a2.bloqueadas.length === 0, `con otro importe ya no es la suya: el día 5 vuelve a salir (${a2.polizas} · ${a2.bloqueadas.length})`);

    await ponerSuPoliza(100.00);
    let err = null;
    try { await armado.generarArchivoMes(MES); } catch (e) { err = e; }
    check(/lo frena el dictamen \(1 pólizas: [^)]*ya_capturada 1/.test(String(err && err.message)),
      `si todo lo pendiente está frenado no hay archivo, y lo dice: «${String(err && err.message).slice(0, 80)}…»`);
  } finally {
    try {
      await admin('analytics.gl_poliza_lines').where(suPoliza).del();
      await admin('analytics.gl_polizas').where(suPoliza).del();
      await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).del();
      await admin('contpaqi.account_rules').where({ tenant_id: MEGA, categoria_code: CAT }).del();
      if (ids.cuenta) await admin('finance.bank_accounts').where({ id: ids.cuenta }).del(); // cascada: estado y movimientos
      if (ids.categoria) await admin('finance.movement_categories').where({ id: ids.categoria }).del();
      await admin('analytics.contpaqi_accounts').where({ tenant_id: MEGA }).whereIn('codigo', [GASTO, BANCO]).del();
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
