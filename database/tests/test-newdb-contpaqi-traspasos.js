/* eslint-disable no-console */
/**
 * `[CP.8.92]` — Candado de **los traspasos entre cuentas en el archivo**: una póliza de DIARIO por cuenta de origen y
 * mes, armada con las dos piernas de Bancos, que sale en el TXT como tipo 3 y que el dictamen frena si ella ya la
 * capturó (`[CP.8.88]`), traspaso por traspaso.
 *
 *   [B] contra PROD, sólo lectura: septiembre de 2026, que ella capturó: el armado da sus pólizas de traspasos (diario,
 *       fin de mes, cuadradas) y el dictamen las frena todas; el archivo las deja fuera.
 *   [C] contra destino LOCAL (job `pruebas-db`), escribiendo como `app_runtime`: dos cuentas, dos traspasos y una
 *       salida sin entrada. Sale UNA póliza tipo 3 con 4 renglones; la salida suelta se declara con su motivo; con su
 *       póliza de diario se frena entera, y con UNO de los dos traspasos también; entregada, no se vuelve a mandar.
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
const MES = '2001-04';
const ORIGEN = '1020990003';
const DESTINO = '1020990004';
const POR = 'candado-cp892';
const FOLIO = '89201';
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
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.92 los traspasos en el archivo: ${ok} ✓ / ${fail} ✗`
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
  console.log(`\n[B] Contra prod, sólo lectura: ${MES_REAL}, que ella ya capturó`);
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query("SET default_transaction_read_only = on; SET app.tenant_id = ''", (e) => d(e, c)) },
  });
  try {
    const armado = servicio(pool);
    const dic = await armado.dictamenDelMes(MES_REAL);
    const tr = dic.polizas.filter((p) => p.evento_tipo === 'bank_traspaso');
    console.log(`    ${tr.length} pólizas de traspasos · ${tr.filter((p) => p.veredicto === 'bloqueada').length} frenadas`);
    check(tr.length >= 10, `el armado da las pólizas de traspasos del mes como app_runtime: ${tr.length}`);
    check(tr.every((p) => p.tipo === 'traspaso' && p.fecha === '2026-09-30'), 'todas de diario, fechadas a fin de mes');
    check(tr.every((p) => p.veredicto === 'bloqueada' && p.hallazgos.some((x) => /^ya_capturada/.test(x.regla))),
      '⭐ ella capturó septiembre: el dictamen frena todas por «ya capturada» (entera o en parte)');
    let arch = null;
    try { arch = await armado.generarArchivoMes(MES_REAL); } catch (e) { arch = { error: e.message }; }
    const fuera = new Set((arch.bloqueadas ?? []).filter((b) => b.evento_tipo === 'bank_traspaso').map((b) => b.clave));
    check(arch.error ? /lo frena el dictamen/.test(arch.error) : tr.every((p) => fuera.has(p.clave)),
      `el archivo no lleva ninguna: ${arch.error ? 'no hay archivo' : `${fuera.size} fuera`}`);
    noMedido('armar, entregar y no reenviar: contra prod no se escribe desde una prueba — corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[C] Contra destino local, escribiendo como app_runtime');
  assertSafeTarget('test-newdb-contpaqi-traspasos', { url: urlAdmin });
  assertSafeTarget('test-newdb-contpaqi-traspasos', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = { cuentas: [] };
  const suPoliza = { tenant_id: MEGA, source: 'contpaqi', ejercicio: 2001, periodo: 4, tipo_pol: '3', folio: FOLIO };
  try {
    for (const [s, t] of [['contpaqi', 'poliza_exports'], ['analytics', 'contpaqi_accounts'], ['analytics', 'gl_polizas']]) {
      if (!(await admin.schema.withSchema(s).hasTable(t))) { noMedido(`${s}.${t} no existe en este destino`); return; }
    }
    const cat = await admin('finance.movement_categories').where({ tenant_id: MEGA, code: 'traspaso_entre_cuentas' }).first('id');
    if (!cat) { noMedido('la categoría traspaso_entre_cuentas no existe en este destino'); return; }
    // Siembra con postgres (salta el RLS: siembra, no prueba).
    await admin('analytics.contpaqi_accounts').insert([[ORIGEN, 'CANDADO A CP892'], [DESTINO, 'CANDADO B CP892']]
      .map(([codigo, nombre]) => ({ tenant_id: MEGA, codigo, nombre, tipo: 'A', es_baja: false, afectable: 1 })));
    const est = {};
    for (const [codigo, etiqueta] of [[ORIGEN, 'CP892A'], [DESTINO, 'CP892B']]) {
      const [c] = await admin('finance.bank_accounts').insert({ tenant_id: MEGA, bank: 'CANDADO', account_label: etiqueta, alias: etiqueta, kind: 'bank', contpaqi_cuenta: codigo }).returning('id');
      const id = c.id ?? c;
      ids.cuentas.push(id);
      const [s] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: id, period: MES }).returning('id');
      est[codigo] = { cuenta: id, estado: s.id ?? s };
    }
    const pierna = async (n, codigo, fecha, sale, entra) => {
      const [m] = await admin('finance.bank_movements').insert({
        tenant_id: MEGA, statement_id: est[codigo].estado, bank_account_id: est[codigo].cuenta, movement_date: fecha,
        client_uuid: `cp892-candado-${n}`, concept: `CANDADO CP892 ${n}`, amount_out: sale, amount_in: entra, category_id: cat.id,
      }).returning('id');
      return String(m.id ?? m);
    };
    const s1 = await pierna(1, ORIGEN, '2001-04-10', 1000.00, 0);
    await pierna(2, DESTINO, '2001-04-10', 0, 1000.00);
    await pierna(3, ORIGEN, '2001-04-11', 250.50, 0);
    await pierna(4, DESTINO, '2001-04-11', 0, 250.50);
    const suelta = await pierna(5, ORIGEN, '2001-04-12', 77.00, 0);
    check(true, 'sembrado: dos cuentas en el catálogo, dos traspasos y una salida sin entrada');

    const { parsearTxt } = require(path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'purchase-book', 'poliza-txt.ts'));
    const armado = servicio(runtime);
    const a0 = await armado.generarArchivoMes(MES);
    const p0 = parsearTxt(a0.contenido);
    check(a0.polizas === 1 && a0.bloqueadas.length === 0, `sale UNA póliza de traspasos (${a0.polizas}) y nada frenado`);
    check(p0.header && p0.header.tipo_pol === '3' && p0.movimientos.length === 4 && !p0.invalidos.length,
      `en el TXT va de diario con 4 renglones: tipo ${p0.header && p0.header.tipo_pol} · ${p0.movimientos.length} renglones`);

    const estados = new Map();
    await armado.conTenant(() => armado.construirLotes(MES, estados));
    check((estados.get(s1) || {}).clave === `traspaso|${ORIGEN}|${MES}`, `la pierna armada queda con la clave de su póliza (${(estados.get(s1) || {}).clave})`);
    check((estados.get(suelta) || {}).motivo === 'traspaso_salida_sin_entrada', `la salida sin entrada se declara: ${(estados.get(suelta) || {}).motivo}`);

    const d0 = await armado.dictamenDelMes(MES);
    const t0 = d0.polizas.find((p) => p.evento_tipo === 'bank_traspaso');
    check(t0 && t0.clave === `${ORIGEN}|${MES}` && t0.tipo === 'traspaso' && t0.fecha === '2001-04-30' && t0.veredicto !== 'bloqueada',
      `la pantalla la ve: ${t0 ? `${t0.clave} · ${t0.fecha} · ${t0.veredicto}` : 'no está'}`);

    const ponerSuPoliza = async (pares) => {
      await admin('analytics.gl_poliza_lines').where(suPoliza).del();
      await admin('analytics.gl_polizas').where(suPoliza).del();
      if (!pares.length) return;
      const total = pares.reduce((s, i) => s + i, 0);
      await admin('analytics.gl_polizas').insert({ ...suPoliza, anio_mes: MES, fecha: '2001-04-30', concepto: 'TRASPASOS ENTRE CUENTAS CP892A', cargos: total, abonos: total, num_lines: pares.length * 2 });
      await admin('analytics.gl_poliza_lines').insert(pares.flatMap((importe, i) => [
        { ...suPoliza, num_movto: i * 2 + 1, cuenta: DESTINO, cargo_abono: 'C', importe, anio_mes: MES },
        { ...suPoliza, num_movto: i * 2 + 2, cuenta: ORIGEN, cargo_abono: 'A', importe, anio_mes: MES },
      ]));
    };
    const frena = async () => { try { await armado.generarArchivoMes(MES); return null; } catch (e) { return String(e.message); } };

    await ponerSuPoliza([1000.00, 250.50]);
    const e1 = await frena();
    check(/lo frena el dictamen \(1 pólizas: [^)]*ya_capturada 1/.test(String(e1)), `⭐ con su póliza de diario se frena entera: «${String(e1).slice(0, 80)}…»`);
    await ponerSuPoliza([1000.00]);
    const e2 = await frena();
    check(/ya_capturada_en_parte 1/.test(String(e2)), `⛔ con UNO de los dos ya capturado también se frena (duplicaría ése): «${String(e2).slice(0, 80)}…»`);

    await ponerSuPoliza([]);
    const a1 = await armado.generarArchivoMes(MES);
    await armado.marcarEntregado(MES, Buffer.from(a1.contenido, 'latin1').toString('base64'), POR);
    const fila = await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).first();
    check(fila && fila.evento_tipo === 'bank_traspaso' && fila.evento_id === `${ORIGEN}|${MES}` && Number(fila.asiento.tipo_poliza) === 3,
      `entregada como bank_traspaso de diario: ${fila ? `${fila.evento_tipo} · ${fila.evento_id}` : 'sin fila'}`);
    const e3 = await frena();
    check(/ya se entregó/.test(String(e3)), `⛔ entregada, no se vuelve a mandar: «${String(e3).slice(0, 70)}…»`);
  } finally {
    try {
      await admin('analytics.gl_poliza_lines').where(suPoliza).del();
      await admin('analytics.gl_polizas').where(suPoliza).del();
      await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).del();
      if (ids.cuentas.length) await admin('finance.bank_accounts').whereIn('id', ids.cuentas).del(); // cascada: estados y movimientos
      await admin('analytics.contpaqi_accounts').where({ tenant_id: MEGA }).whereIn('codigo', [ORIGEN, DESTINO]).del();
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
