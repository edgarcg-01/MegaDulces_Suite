/* eslint-disable no-console */
/**
 * `[CP.8.51]` + `[CP.8.53]` — Candado de **la firma de reglas de cuenta** y de su efecto.
 *
 * Tres partes, porque fallan por motivos distintos:
 *
 *   [A] la regla, pura (`firma-regla.ts`): cada rechazo con su motivo — forma que no se firma,
 *       cuenta que no es de gasto, de mayor, dada de baja, inexistente, sin autor. Siempre corre.
 *   [B] contra PROD, sólo lectura: las reglas como las vería la pantalla (las 21 filas, las
 *       firmables, el orden por dinero, el indicio sin preselección) y el catálogo de gasto.
 *   [C] contra destino LOCAL (job `pruebas-db`), escribiendo como `app_runtime`:
 *       firmar → la categoría ENTRA al archivo; ⛔ lo ya entregado NO vuelve a viajar (importarlo
 *       otra vez lo duplicaría en ContPAQi) y un lote entregado que cambió se declara; revocar →
 *       la categoría deja de armarse. Limpia lo sembrado.
 *
 * `[CP.8.87]` La firma «por proveedor» de un gasto escribe una forma (`por_proveedor`, prefijo 52, sin cuenta) que
 * sólo el CHECK de la base acepta o rechaza: [A] su regla pura y [C] firmarla, firmarla dos veces, revocarla y que el
 * armado lleve su egreso al camino del gasto con motivo, contra la base y no contra un doble.
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
const MES = '2001-02';
const CAT = 'cp853_candado';
const CUENTA = '5299990001';
const BANCO = '1020990001';
const POR = 'candado-cp853';
const CAT_G = 'cp887_candado';

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const silencio = { log() {}, warn() {}, error() {}, debug() {} };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.53 firma de reglas: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};

function pura() {
  console.log('\n[A] La regla de firma, pura');
  const { validarFirma, validarRevocacion, esFirmable } = require(path.join(SRC, 'firma-regla.ts'));
  const cat = { categoria_code: 'x', tipo_regla: 'por_categoria', estado: 'sin_regla' };
  const buena = { codigo: '5200650000', nombre: 'COMISIONES', afectable: 1, es_baja: false };
  const v = (o) => validarFirma({ regla: cat, cuenta: '5200650000', catalogo: buena, por: 'yo', ...o });
  check(v({}).ok === true, 'una cuenta de gasto, afectable y viva, con autor: se firma');
  for (const t of ['por_proveedor', 'por_sucursal', 'sin_medir', 'no_aplica']) {
    const r = v({ regla: { ...cat, tipo_regla: t } });
    check(!r.ok && /no se firma con una cuenta/.test(r.motivo), `⛔ ${t} no se firma con una cuenta`);
    check(esFirmable({ ...cat, tipo_regla: t }).firmable === false, `   y esFirmable lo dice (${t})`);
  }
  check(!v({ cuenta: '1020080000', catalogo: { ...buena, codigo: '1020080000' } }).ok, '⛔ una cuenta de BANCO no: no es gasto');
  check(!v({ cuenta: '2120000112', catalogo: { ...buena, codigo: '2120000112' } }).ok, '⛔ una cuenta de PROVEEDOR no: no es gasto');
  check(!v({ catalogo: { ...buena, afectable: 0 } }).ok, '⛔ una cuenta de mayor (no afectable) no');
  check(!v({ catalogo: { ...buena, es_baja: true } }).ok, '⛔ una cuenta dada de baja no');
  check(!v({ catalogo: null }).ok, '⛔ una cuenta que no existe en el catálogo no');
  check(!v({ cuenta: '52006' }).ok, '⛔ una cuenta mal formada no');
  check(!v({ por: '' }).ok, '⛔ sin autor no');
  check(!v({ regla: null }).ok, '⛔ sin regla no');
  check(validarRevocacion({ ...cat, estado: 'aprobada' }, 'yo').ok, 'revocar lo firmado sí');
  check(!validarRevocacion(cat, 'yo').ok, '⛔ revocar lo que no está firmado no');

  const { validarFirmaPorProveedor } = require(path.join(SRC, 'firma-regla.ts'));
  const pp = (o) => validarFirmaPorProveedor({ regla: cat, grupo: 'gasto', por: 'yo', ...o });
  check(pp({}).ok === true, '[CP.8.87] un gasto por categoría, sin cuenta firmada, con autor: se firma «por proveedor»');
  check(pp({ regla: { ...cat, tipo_regla: 'sin_medir' } }).ok === true, '[CP.8.87] uno sin medir también');
  check(!pp({ grupo: 'compra' }).ok && !pp({ grupo: null }).ok, '⛔ [CP.8.87] lo que no es del grupo gasto no (una compra ya va por proveedor con su 2120)');
  check(!pp({ regla: { ...cat, tipo_regla: 'por_proveedor', cuenta_prefijo: '52' } }).ok, '⛔ [CP.8.87] lo que ya va por proveedor no');
  for (const t of ['por_sucursal', 'no_aplica']) check(!pp({ regla: { ...cat, tipo_regla: t } }).ok, `⛔ [CP.8.87] ${t} no`);
  check(!pp({ regla: { ...cat, estado: 'aprobada' } }).ok, '⛔ [CP.8.87] con una cuenta ya firmada no: se revoca antes');
  check(!pp({ por: '' }).ok && !pp({ regla: null }).ok, '⛔ [CP.8.87] sin autor o sin regla no');
}

function servicios(pool) {
  const { ContpaqiArmadoService, FirmaRechazada } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
  const { ContpaqiTxtSinkAdapter } = require(path.join(SRC, 'txt-sink.adapter.ts'));
  const armado = new ContpaqiArmadoService(pool, new ContpaqiTxtSinkAdapter());
  armado.log = silencio;
  return { armado, FirmaRechazada };
}

async function soloLectura(url) {
  console.log('\n[B] Contra prod, sólo lectura: lo que vería la pantalla');
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query("SET default_transaction_read_only = on; SET app.tenant_id = ''", (e) => d(e, c)) },
  });
  try {
    const { armado } = servicios(pool);
    const rs = await armado.reglas('2026-09');
    const filas = rs.filter((r) => r.tiene_fila);
    check(filas.length >= 21, `ve las ${filas.length} reglas como app_runtime (sin tenant de sesión)`);
    const firmables = rs.filter((r) => r.firmable);
    check(firmables.length > 0 && firmables.every((r) => r.tipo_regla === 'por_categoria'),
      `firmables: ${firmables.length}, todas por_categoria (${firmables.map((r) => r.categoria_code).join(', ')})`);
    check(rs.filter((r) => !r.firmable).every((r) => r.motivo_no_firmable),
      'cada regla que no se firma dice por qué');
    check(rs.every((r, i) => i === 0 || rs[i - 1].importe_mes >= r.importe_mes), 'ordenadas por dinero del mes, de mayor a menor');
    check(rs.some((r) => r.indicio) && rs.filter((r) => r.estado !== 'aprobada').every((r) => !r.cuenta_gasto || r.estado === 'sin_regla'),
      'trae indicios y no los aplica: ninguna regla sin firmar lleva cuenta puesta por el sistema');
    const sinFila = rs.filter((r) => !r.tiene_fila);
    console.log(`  · categorías con egresos y SIN fila en account_rules: ${sinFila.length}`
      + (sinFila.length ? ` (${sinFila.map((r) => r.categoria_code).join(', ')})` : ''));
    const cs = await armado.cuentasGasto();
    check(cs.length > 100 && cs.every((c) => c.codigo.startsWith('52')), `catálogo de gasto: ${cs.length} cuentas 52* afectables`);
    noMedido('firmar y revocar: contra prod no se escribe desde una prueba — corre completo en `pruebas-db`');
  } finally {
    await pool.destroy();
  }
}

async function completo(urlAdmin, urlRuntime) {
  console.log('\n[C] Contra destino local, escribiendo como app_runtime');
  assertSafeTarget('test-newdb-contpaqi-firma', { url: urlAdmin });
  assertSafeTarget('test-newdb-contpaqi-firma', { url: urlRuntime });
  const admin = knexLib({ client: 'pg', connection: urlAdmin, pool: { min: 0, max: 2 } });
  const runtime = knexLib({ client: 'pg', connection: urlRuntime, pool: { min: 0, max: 3 } });
  const ids = {};
  try {
    for (const [s, t] of [['contpaqi', 'account_rules'], ['contpaqi', 'poliza_exports'], ['analytics', 'contpaqi_accounts']]) {
      if (!(await admin.schema.withSchema(s).hasTable(t))) { noMedido(`${s}.${t} no existe en este destino`); return; }
    }
    // Siembra con postgres (salta el RLS: siembra, no prueba).
    await admin('analytics.contpaqi_accounts').insert({ tenant_id: MEGA, codigo: CUENTA, nombre: 'CANDADO CP853', tipo: 'G', es_baja: false, afectable: 1 });
    // `[CP.8.88]` El banco también va al catálogo: una póliza con una cuenta que ContPAQi no tiene la frena el dictamen.
    await admin('analytics.contpaqi_accounts').insert({ tenant_id: MEGA, codigo: BANCO, nombre: 'CANDADO BANCO CP853', tipo: 'A', es_baja: false, afectable: 1 });
    const [cta] = await admin('finance.bank_accounts').insert({ tenant_id: MEGA, bank: 'CANDADO', account_label: 'CP853', kind: 'bank', contpaqi_cuenta: '1020990001' }).returning('id');
    ids.cuenta = cta.id ?? cta;
    const [est] = await admin('finance.bank_statements').insert({ tenant_id: MEGA, bank_account_id: ids.cuenta, period: MES }).returning('id');
    const [cat] = await admin('finance.movement_categories').insert({ tenant_id: MEGA, code: CAT, name: 'Candado CP.8.53', flow: 'out', group_key: 'candado' }).returning('id');
    ids.categoria = cat.id ?? cat;
    await admin('contpaqi.account_rules').insert({ tenant_id: MEGA, categoria_code: CAT, tipo_regla: 'por_categoria', estado: 'sin_regla', concepto_medido: 'candado', forma_medida: { candidata: `${CUENTA} CANDADO (90%)` } });
    const mov = (i, fecha, imp) => admin('finance.bank_movements').insert({
      tenant_id: MEGA, statement_id: est.id ?? est, bank_account_id: ids.cuenta, movement_date: fecha,
      client_uuid: `cp853-candado-${i}`, concept: `CANDADO CP853 ${i}`, amount_out: imp, category_id: ids.categoria,
    });
    await mov(0, '2001-02-03', 300.00);
    await mov(1, '2001-02-04', 120.50);
    check(true, 'sembrado: cuenta 52* en el catálogo, una regla sin firmar, 2 egresos en 2 días');

    const { armado, FirmaRechazada } = servicios(runtime);
    let err = null;
    try { await armado.generarArchivoMes(MES); } catch (e) { err = e; }
    check(err !== null, 'sin firma, el mes no produce archivo (la categoría está en sin_regla)');

    let rech = null;
    try { await armado.firmarRegla(CAT, '1020990001', POR); } catch (e) { rech = e; }
    check(rech instanceof FirmaRechazada, '⛔ firmar con una cuenta de banco se rechaza');

    const firmada = await armado.firmarRegla(CAT, CUENTA, POR);
    check(firmada.estado === 'aprobada' && firmada.cuenta_gasto === CUENTA && firmada.aprobada_por === POR,
      `firmada: ${firmada.estado} → ${firmada.cuenta_gasto} por ${firmada.aprobada_por}`);
    const a1 = await armado.generarArchivoMes(MES);
    check(a1.polizas === 2, `⭐ firmada, la categoría ENTRA: ${a1.polizas} pólizas (una por día)`);

    // Contabilidad marca entregada la del día 3; el archivo siguiente no la vuelve a traer.
    const b64 = Buffer.from(a1.contenido, 'latin1').toString('base64');
    await armado.marcarEntregado(MES, b64, POR);
    const conDia3 = await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).count({ n: '*' }).first();
    check(Number(conDia3.n) === 2, 'las 2 quedan registradas como entregadas');
    await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).where('evento_id', 'like', '%2001-02-04').del();
    const a2 = await armado.generarArchivoMes(MES);
    check(a2.polizas === 1 && a2.ya_entregadas === 1, `⛔ lo entregado NO se reenvía: ${a2.polizas} póliza nueva, ${a2.ya_entregadas} ya entregada fuera`);

    // Un egreso nuevo en el día ya entregado: ese lote cambió y no debe reenviarse.
    await mov(2, '2001-02-03', 50.00);
    const a3 = await armado.generarArchivoMes(MES);
    check(a3.cambiados.length === 1 && a3.polizas === 1,
      `un lote entregado que cambió se DECLARA y no se reenvía: cambiados=${a3.cambiados.join(',')}`);

    const rev = await armado.revocarRegla(CAT, POR);
    check(rev.estado === 'sin_regla' && rev.cuenta_gasto === CUENTA, 'revocada: vuelve a sin_regla y conserva la última cuenta firmada');
    let err2 = null;
    try { await armado.generarArchivoMes(MES); } catch (e) { err2 = e; }
    check(err2 !== null, 'revocada, la categoría deja de armarse');

    // `[CP.8.87]` La firma «por proveedor» de un gasto, contra la base.
    const [catG] = await admin('finance.movement_categories').insert({ tenant_id: MEGA, code: CAT_G, name: 'Candado CP.8.87', flow: 'out', group_key: 'gasto' }).returning('id');
    ids.categoriaG = catG.id ?? catG;
    await admin('contpaqi.account_rules').insert({ tenant_id: MEGA, categoria_code: CAT_G, tipo_regla: 'por_categoria', estado: 'sin_regla', concepto_medido: 'candado' });
    let rechG = null;
    try { await armado.firmarPorProveedor(CAT, POR); } catch (e) { rechG = e; }
    check(rechG instanceof FirmaRechazada, '⛔ [CP.8.87] una categoría que no es del grupo gasto no se firma «por proveedor»');
    const vistaG = await armado.firmarPorProveedor(CAT_G, POR);
    const filaG = await admin('contpaqi.account_rules').where({ tenant_id: MEGA, categoria_code: CAT_G }).first();
    check(filaG.tipo_regla === 'por_proveedor' && filaG.cuenta_prefijo === '52' && filaG.cuenta_gasto === null
      && filaG.estado === 'aprobada' && filaG.aprobada_por === POR,
    `[CP.8.87] firmada «por proveedor» y el CHECK la aceptó: ${filaG.tipo_regla} · ${filaG.cuenta_prefijo} · ${filaG.estado} por ${filaG.aprobada_por}`);
    check(vistaG.por_proveedor_gasto === true && vistaG.firmable_por_proveedor === false, '[CP.8.87] la vista la dice «por proveedor» y ya no se firma así otra vez');
    let rechG2 = null;
    try { await armado.firmarPorProveedor(CAT_G, POR); } catch (e) { rechG2 = e; }
    check(rechG2 instanceof FirmaRechazada, '⛔ [CP.8.87] firmarla dos veces se rechaza');

    // Su egreso va al camino del gasto: el concepto no nombra a ningún proveedor del padrón, así que NO se arma y lo dice.
    const [movG] = await admin('finance.bank_movements').insert({
      tenant_id: MEGA, statement_id: est.id ?? est, bank_account_id: ids.cuenta, movement_date: '2001-02-05',
      client_uuid: 'cp887-candado-0', concept: 'CANDADO CP887 SIN PROVEEDOR', amount_out: 75.00, category_id: ids.categoriaG,
    }).returning('id');
    try {
      const estados = new Map();
      const { lotes } = await armado.conTenant(() => armado.construirLotes(MES, estados));
      const st = estados.get(String(movG.id ?? movG));
      check(st && st.motivo === 'gasto_sin_proveedor' && !lotes.some((l) => l.evento_tipo === 'bank_gasto'),
        `[CP.8.87] su egreso no se arma solo y dice por qué: ${st ? st.motivo : 'sin estado'}`);
    } catch (e) {
      if (/does not exist|no existe/.test(String(e.message))) noMedido(`[CP.8.87] el camino del gasto: este destino no tiene una tabla de la fuente (${e.message})`);
      else throw e;
    }

    const revG = await armado.revocarRegla(CAT_G, POR);
    const filaG2 = await admin('contpaqi.account_rules').where({ tenant_id: MEGA, categoria_code: CAT_G }).first();
    check(filaG2.tipo_regla === 'por_categoria' && filaG2.cuenta_prefijo === null && filaG2.estado === 'sin_regla' && revG.firmable_por_proveedor === true,
      '[CP.8.87] revocada: vuelve a por categoría sin cuenta (el CHECK la aceptó) y se puede volver a firmar');
  } finally {
    try {
      await admin('contpaqi.poliza_exports').where({ tenant_id: MEGA, periodo: MES }).del();
      await admin('contpaqi.account_rules').where({ tenant_id: MEGA }).whereIn('categoria_code', [CAT, CAT_G]).del();
      if (ids.cuenta) await admin('finance.bank_accounts').where({ id: ids.cuenta }).del();
      if (ids.categoria) await admin('finance.movement_categories').where({ id: ids.categoria }).del();
      if (ids.categoriaG) await admin('finance.movement_categories').where({ id: ids.categoriaG }).del();
      await admin('analytics.contpaqi_accounts').where({ tenant_id: MEGA }).whereIn('codigo', [CUENTA, BANCO]).del();
    } catch (e) {
      console.log(`  ⚠ limpieza incompleta: ${e.message}`);
    }
    await admin.destroy();
    await runtime.destroy();
  }
}

(async () => {
  pura();
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
