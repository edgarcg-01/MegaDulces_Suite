/* eslint-disable no-console */
/**
 * `[CP.8.91]` — Candado de **las comisiones bancarias por banco y mes en el archivo** (D6): con `comision_bancaria`
 * firmada, las comisiones salen del lote del día y van en UNA póliza de egreso por banco, con los cargos agregados y
 * un abono por movimiento; el dictamen la frena si ella ya capturó alguno de sus movimientos.
 *
 *   [B] contra PROD, sólo lectura, con la firma SIMULADA en memoria (en prod no está firmada y una prueba no firma):
 *       septiembre de 2026, que ella capturó: las pólizas de comisiones salen agrupadas, ninguna comisión queda en el
 *       lote del día, y el dictamen las frena todas.
 *   [C] contra destino LOCAL (job `pruebas-db`), escribiendo como `app_runtime`: sin firma, las comisiones siguen en el
 *       lote del día; firmada por el camino real, sale una póliza tipo 2 con 2 cargos y 6 abonos (con un IVA suelto);
 *       con su póliza se frena entera, con dos de sus movimientos también; entregada, no se vuelve a mandar. La regla
 *       firmada se RESTAURA al final: es la de la base, no una sembrada.
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
const MES = '2001-08';
const BANCO = '1020990006';
const GASTO = '5299990006';
const IVA = '1060000000';
const CAT = 'comision_bancaria';
const POR = 'candado-cp891';
const FOLIO = '89101';
const MES_REAL = '2026-09';
const GASTO_REAL = '5200650000';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const silencio = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.91 las comisiones por banco y mes: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

function servicio(pool) {
  const { ContpaqiArmadoService, FirmaRechazada } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
  const { ContpaqiTxtSinkAdapter } = require(path.join(SRC, 'txt-sink.adapter.ts'));
  const armado = new ContpaqiArmadoService(pool, new ContpaqiTxtSinkAdapter());
  armado.log = silencio;
  return { armado, FirmaRechazada };
}

async function soloLectura(url) {
  console.log(`\n[B] Contra prod, sólo lectura, con la firma simulada en memoria: ${MES_REAL}`);
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query("SET default_transaction_read_only = on; SET app.tenant_id = ''", (e) => d(e, c)) },
  });
  try {
    const { armado } = servicio(pool);
    const leer = armado.leerReglas.bind(armado);
    armado.leerReglas = async () => {
      const m = await leer();
      const r = m.get(CAT);
      if (r) m.set(CAT, { ...r, estado: 'aprobada', cuenta_gasto: GASTO_REAL });
      return m;
    };
    const estados = new Map();
    const { lotes } = await armado.conTenant(() => armado.construirLotes(MES_REAL, estados));
    const com = lotes.filter((l) => l.evento_tipo === 'bank_comisiones');
    console.log(`    ${com.length} pólizas de comisiones · ${com.reduce((a, l) => a + l.resumen.movimientos, 0)} comisiones`);
    check(com.length >= 8 && com.every((l) => l.asiento && l.asiento.tipo_poliza === 2 && l.asiento.fecha === '2026-09-30'),
      `firmada, salen agrupadas por banco: ${com.length} pólizas de egreso a fin de mes`);
    // El otro camino: las comisiones del mes que lee el armado, contadas aparte. Ninguna puede quedar en el lote del día.
    const delMes = (await armado.conTenant(() => armado.leerEgresos(MES_REAL)))
      .filter((e) => e.categoria_code === CAT && e.cuenta_banco && !e.fuera_del_estado).map((e) => String(e.id));
    const conPoliza = delMes.filter((id) => String((estados.get(id) || {}).clave ?? '').startsWith('comisiones|')).length;
    check(delMes.length > 0 && conPoliza === delMes.length, `todas las comisiones del mes quedan en su póliza mensual, ninguna en el lote del día: ${conPoliza} de ${delMes.length}`);
    const dic = await armado.dictamenDelMes(MES_REAL);
    const d = dic.polizas.filter((p) => p.evento_tipo === 'bank_comisiones');
    console.log(`    dictamen: ${d.filter((p) => p.veredicto === 'bloqueada').length} de ${d.length} frenadas`);
    check(d.length === com.length && d.every((p) => p.veredicto === 'bloqueada' && p.hallazgos.some((x) => /^ya_capturada/.test(x.regla))),
      '⭐ ella capturó septiembre: el dictamen frena todas por «ya capturada» (entera o en parte)');
    check(d.every((p) => !p.hallazgos.some((x) => x.regla === 'pata_de_banco')), 'ninguna se marca por «varios abonos al banco»: es su forma');
    noMedido('firmar, entregar y no reenviar: contra prod no se escribe desde una prueba — corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[C] Contra destino local, escribiendo como app_runtime');
  assertSafeTarget('test-newdb-contpaqi-comisiones', { url: urlAdmin });
  assertSafeTarget('test-newdb-contpaqi-comisiones', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = {};
  let original = null;
  const suPoliza = { tenant_id: MEGA, source: 'contpaqi', ejercicio: 2001, periodo: 8, tipo_pol: '2', folio: FOLIO };
  try {
    for (const [s, t] of [['contpaqi', 'account_rules'], ['analytics', 'contpaqi_accounts'], ['analytics', 'gl_polizas']]) {
      if (!(await admin.schema.withSchema(s).hasTable(t))) { noMedido(`${s}.${t} no existe en este destino`); return; }
    }
    original = await admin('contpaqi.account_rules').where({ tenant_id: MEGA, categoria_code: CAT }).first();
    const cats = Object.fromEntries((await admin('finance.movement_categories').where({ tenant_id: MEGA }).whereIn('code', [CAT, 'iva_acreditable']).select('code', 'id')).map((r) => [r.code, r.id]));
    if (!original || original.tipo_regla !== 'por_categoria' || original.estado === 'aprobada' || !cats[CAT] || !cats.iva_acreditable) {
      noMedido(`la regla ${CAT} o sus categorías no están como en prod (por_categoria sin firmar) en este destino`);
      return;
    }
    // Siembra con postgres (salta el RLS: siembra, no prueba). Del catálogo se borra al final sólo lo insertado aquí.
    ids.catalogo = (await admin('analytics.contpaqi_accounts').insert([[GASTO, 'CANDADO COMISIONES CP891', 'G'], [BANCO, 'CANDADO BANCO CP891', 'A'], [IVA, 'IVA ACREDITABLE', 'A']]
      .map(([codigo, nombre, tipo]) => ({ tenant_id: MEGA, codigo, nombre, tipo, es_baja: false, afectable: 1 })))
      .onConflict(['tenant_id', 'codigo']).ignore().returning('codigo')).map((r) => r.codigo ?? r);
    const [cta] = await admin('finance.bank_accounts').insert({ tenant_id: MEGA, bank: 'CANDADO', account_label: 'CP891', alias: 'CANDADO CP891', kind: 'bank', contpaqi_cuenta: BANCO }).returning('id');
    ids.cuenta = cta.id ?? cta;
    const [est] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: ids.cuenta, period: MES }).returning('id');
    const mov = async (n, fecha, imp, cat) => {
      const [m] = await admin('finance.bank_movements').insert({
        tenant_id: MEGA, statement_id: est.id ?? est, bank_account_id: ids.cuenta, movement_date: fecha,
        client_uuid: `cp891-candado-${n}`, concept: `CANDADO CP891 ${n}`, amount_out: imp, category_id: cats[cat],
      }).returning('id');
      return String(m.id ?? m);
    };
    const c1 = await mov(1, '2001-08-05', 10.00, CAT);
    await mov(2, '2001-08-05', 1.60, 'iva_acreditable');
    await mov(3, '2001-08-05', 25.00, CAT);
    await mov(4, '2001-08-05', 4.00, 'iva_acreditable');
    await mov(5, '2001-08-20', 7.50, CAT);
    await mov(6, '2001-08-28', 3.20, 'iva_acreditable'); // IVA suelto: no hay un egreso de 20.00 ese día
    check(true, 'sembrado: tres comisiones, dos con su IVA y un IVA suelto, en un estado de agosto');

    const { parsearTxt } = require(path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'purchase-book', 'poliza-txt.ts'));
    const { armado } = servicio(runtime);
    const sinFirma = await armado.simularLotes(MES);
    check(!sinFirma.lotes.some((l) => l.tipo === 'comisiones') && sinFirma.lotes.some((l) => l.cuenta_banco === BANCO && l.motivos.sin_regla),
      'sin firma, las comisiones siguen en el lote del día con «sin_regla»');

    await armado.firmarRegla(CAT, GASTO, POR);
    const a0 = await armado.generarArchivoMes(MES);
    const p0 = parsearTxt(a0.contenido);
    check(a0.polizas === 1 && a0.bloqueadas.length === 0 && Math.round(a0.total * 100) === 5130,
      `firmada, sale UNA póliza de comisiones por 51.30: ${a0.polizas} · total ${a0.total}`);
    check(p0.header && p0.header.tipo_pol === '2' && p0.movimientos.length === 8 && !p0.invalidos.length,
      `en el TXT va de egreso con 2 cargos y 6 abonos: tipo ${p0.header && p0.header.tipo_pol} · ${p0.movimientos.length} renglones`);
    const estados = new Map();
    await armado.conTenant(() => armado.construirLotes(MES, estados));
    check((estados.get(c1) || {}).clave === `comisiones|${BANCO}|${MES}`, `la comisión queda con la clave de su póliza (${(estados.get(c1) || {}).clave})`);

    const ponerSuPoliza = async (abonos) => {
      await admin('analytics.gl_poliza_lines').where(suPoliza).del();
      await admin('analytics.gl_polizas').where(suPoliza).del();
      if (!abonos.length) return;
      const total = abonos.reduce((s, i) => s + i, 0);
      await admin('analytics.gl_polizas').insert({ ...suPoliza, anio_mes: MES, fecha: '2001-08-31', concepto: 'PAGO COMISIONES CANDADO CP891', cargos: total, abonos: total, num_lines: abonos.length + 1 });
      await admin('analytics.gl_poliza_lines').insert([
        { ...suPoliza, num_movto: 1, cuenta: GASTO, cargo_abono: 'C', importe: total, anio_mes: MES },
        ...abonos.map((importe, i) => ({ ...suPoliza, num_movto: i + 2, cuenta: BANCO, cargo_abono: 'A', importe, anio_mes: MES })),
      ]);
    };
    const frena = async () => { try { await armado.generarArchivoMes(MES); return null; } catch (e) { return String(e.message); } };
    await ponerSuPoliza([10, 1.6, 25, 4, 7.5, 3.2]);
    const e1 = await frena();
    check(/lo frena el dictamen \(1 pólizas: [^)]*ya_capturada 1/.test(String(e1)), `⭐ con su póliza del mes se frena entera: «${String(e1).slice(0, 80)}…»`);
    await ponerSuPoliza([10, 1.6]);
    const e2 = await frena();
    check(/ya_capturada_en_parte 1/.test(String(e2)), `⛔ con dos de sus movimientos también se frena: «${String(e2).slice(0, 80)}…»`);

    await ponerSuPoliza([]);
    const a1 = await armado.generarArchivoMes(MES);
    await armado.marcarEntregado(MES, Buffer.from(a1.contenido, 'latin1').toString('base64'), POR);
    const fila = await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).first();
    check(fila && fila.evento_tipo === 'bank_comisiones' && fila.evento_id === `${BANCO}|${MES}`, `entregada como bank_comisiones: ${fila ? fila.evento_id : 'sin fila'}`);
    const e3 = await frena();
    check(/ya se entregó/.test(String(e3)), `⛔ entregada, no se vuelve a mandar: «${String(e3).slice(0, 70)}…»`);
  } finally {
    try {
      await admin('analytics.gl_poliza_lines').where(suPoliza).del();
      await admin('analytics.gl_polizas').where(suPoliza).del();
      await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).del();
      if (original) {
        await admin('contpaqi.account_rules').where({ tenant_id: MEGA, categoria_code: CAT }).update({
          tipo_regla: original.tipo_regla, estado: original.estado, cuenta_gasto: original.cuenta_gasto, cuenta_nombre: original.cuenta_nombre,
          aprobada_por: original.aprobada_por, aprobada_en: original.aprobada_en, cuenta_prefijo: original.cuenta_prefijo,
        });
      }
      if (ids.cuenta) await admin('finance.bank_accounts').where({ id: ids.cuenta }).del(); // cascada: estado y movimientos
      if (ids.catalogo?.length) await admin('analytics.contpaqi_accounts').where({ tenant_id: MEGA }).whereIn('codigo', ids.catalogo).del();
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
