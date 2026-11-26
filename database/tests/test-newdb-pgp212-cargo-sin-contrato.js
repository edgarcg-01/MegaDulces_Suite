#!/usr/bin/env node
/**
 * `[PGP.212]` EL CARGO AUTOMÁTICO Y SU CONTRATO — `finance.v_automatic_bank_charges` contra Postgres real, con los
 * contratos escritos por los caminos REALES de `[PGP.210]` (`contratos-de-cargo.sql.ts`, TS cargado tal cual).
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **Qué es un cargo automático:** los de una serie y los de concepto de cargo automático (la apertura, la
 *     disposición de un mes) entran; un SPEI, un «cargo por pago concentración», una tarjeta que no dice «domicilia» y
 *     la comisión de terminal (CB.62) NO. Cada movimiento una vez.
 *  2. **Sin contratos, todos «sin contrato»** (M1 = 0 %).
 *  3. **Cada motivo, en su caso:** propuesta sin confirmar → confirmada: «con contrato» (⭐ la prueba negativa del
 *     anexo: un contrato confirmado lo saca de la lista); rechazada; fuera de vigencia; importe distinto (fijo y tabla);
 *     por tabla, el pago que casa en importe y ±10 días.
 *  4. **El mejor gana:** con un contrato fuera de vigencia y otro vigente, el cargo queda «con contrato», una vez.
 *  5. **El catálogo:** los motivos del código = los de la migración. **RLS:** otro tenant no ve nada.
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas.
 * ⚠️ Sin la vista (migración 20261126004656 sin aplicar) sale con 2 = NO MEDIDO.
 * ⛔ Escribe (aunque revierta): exige `assert-safe-target`, nunca contra producción.
 */
const path = require('path');
const fs = require('fs');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
{
  const ts = require('typescript');
  const RAIZ = path.resolve(__dirname, '..', '..');
  const cfg = ts.parseConfigFileTextToJson('tsconfig.base.json', fs.readFileSync(path.join(RAIZ, 'tsconfig.base.json'), 'utf8')).config;
  const paths = cfg.compilerOptions.paths || {};
  const Module = require('module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) {
    return orig.call(this, paths[req] ? path.join(RAIZ, paths[req][0]) : req, ...rest);
  };
}
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp212-cargo-sin-contrato', { url: DST });

const SQL = require(path.resolve(__dirname, '../../libs/finance/src/lib/charge-contracts/contratos-de-cargo.sql.ts'));
const { MOTIVOS_CARGO_AUTOMATICO } = require(path.resolve(__dirname, '../../libs/contracts/src/finance/contratos-de-cargo.contract.ts'));
const MIG = require('../migrations-newdb/20261126004656_pgp212_cargo_automatico_y_su_contrato.js');
const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000ac';
const PDF = { storage_key: 'contratos/prueba.pdf', nombre: 'prueba.pdf' };

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const knex = require('knex')({ client: 'pg', connection: { connectionString: DST }, pool: { min: 1, max: 2 } });
const salir = async () => {
  await knex.destroy();
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};
function haceMeses(k, dia) {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); d.setUTCDate(dia);
  return d.toISOString().slice(0, 10);
}
const masDias = (f, n) => { const d = new Date(`${f}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  console.log('\n[PGP.212] el cargo automático y su contrato — vista real, contratos por los caminos reales, transacción que se revierte\n');
  let hay;
  try { hay = (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS t`, [MIG.VISTA])).rows[0].t; } catch (e) { noMedido(`no hay Postgres: ${e.message}`); return salir(); }
  if (!hay) { noMedido(`${MIG.VISTA} no existe (migración 20261126004656 sin aplicar)`); return salir(); }
  ok(JSON.stringify([...MOTIVOS_CARGO_AUTOMATICO].sort()) === JSON.stringify([...MIG.MOTIVOS].sort()), `los motivos del código = los de la migración (${MIG.MOTIVOS.length})`);

  const trx = await knex.transaction();
  try {
    await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    const [cta] = (await trx.raw(`INSERT INTO finance.bank_accounts (tenant_id, bank, account_label, kind) VALUES (?, 'BANCO PRUEBA', '9212', 'bank') RETURNING id::text`, [T])).rows;
    const [est] = (await trx.raw(`INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period) VALUES (?, ?, 'prueba-pgp212') RETURNING id::text`, [T, cta.id])).rows;
    let n = 0;
    const ids = {};
    const mov = async (caso, fecha, importe, concepto) => {
      const [m] = (await trx.raw(`INSERT INTO finance.bank_movements (tenant_id, statement_id, bank_account_id, movement_date, client_uuid, concept, amount_in, amount_out, sync_source)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'upload') RETURNING id::text`, [T, est.id, cta.id, fecha, `pgp212-${++n}`, concepto, importe])).rows;
      (ids[caso] ||= []).push(m.id);
    };
    const INT = [22013.10, 20486.20, 16076.30, 12693.40, 10529.50];
    for (let k = 5; k >= 1; k--) {
      await mov('capital', haceMeses(k, 5), 83333.33, 'PAGO DE CAPITAL 012345678');
      await mov('interes', haceMeses(k, 5), INT[5 - k], 'PAGO DE INTERESES 012345678');
    }
    for (let k = 3; k >= 1; k--) {
      await mov('domi', haceMeses(k, 24), 21291, "DOMICILIACION PAGO SERVICIO '000" + k + "1 RFC AAA010101AAA");
      await mov('domi', haceMeses(k, 27), 21291, 'DOMICILIACION PAGO SERVICIO');
      await mov('terminal', haceMeses(k, 15), 9.35, 'APLI TASA DE DES CREDITO/171234567 TERMINALES PUNTO DE VENTA');
    }
    await mov('apertura', haceMeses(1, 20), 99000, 'COMISION DE PRESTAMO/1234567890 POR APERTURA');
    await mov('bbva', haceMeses(1, 28), 10428.5, 'CREDITO LIQUIDO DISP./1234567890 COBRO DEL PERIODO');
    await mov('spei', haceMeses(1, 10), 50000, 'SPEI ENVIADO PROVEEDOR DE PRUEBA');
    await mov('concentracion', haceMeses(1, 11), 1198, 'CARGO POR PAGO CONCENTRACION TELEFONOS DE MEXICO');
    await mov('tarjeta', haceMeses(1, 12), 11649, 'PAGO TARJETA DE CREDITO/ 0029525036 CUENTA: 4772 BNE');

    let comoRuntime = false;
    try { await trx.raw('SET LOCAL ROLE app_runtime'); comoRuntime = (await trx.raw('SELECT current_user AS u')).rows[0].u === 'app_runtime'; } catch { /* se declara */ }
    if (!comoRuntime) noMedido('esta conexión no puede volverse app_runtime: la vista se prueba con otro rol');

    const leer = async () => (await trx.raw(`SELECT bank_movement_id::text AS id, reason, supported, detected_by, amount::float AS amount FROM ${MIG.VISTA} WHERE bank_account_id = ?`, [cta.id])).rows;
    const casoDe = (id) => Object.keys(ids).find((k) => ids[k].includes(id));
    const motivosDe = (filas, caso) => [...new Set(filas.filter((f) => casoDe(f.id) === caso).map((f) => f.reason))];
    const deCaso = (filas, caso) => filas.filter((f) => casoDe(f.id) === caso);

    console.log(' 1. Qué es un cargo automático');
    let v = await leer();
    ok(v.length === 18 && new Set(v.map((f) => f.id)).size === 18, `18 cargos automáticos, cada movimiento una vez (${v.length})`);
    for (const caso of ['spei', 'concentracion', 'tarjeta', 'terminal']) ok(deCaso(v, caso).length === 0, `NEGATIVA: ${caso} no es un cargo automático del banco`);
    ok(deCaso(v, 'capital').every((f) => f.detected_by === 'serie_y_concepto') && deCaso(v, 'apertura')[0]?.detected_by === 'concepto' && deCaso(v, 'bbva')[0]?.detected_by === 'concepto',
      'el crédito lo ven su serie y su concepto; la apertura y la disposición de un mes, sólo su concepto');

    console.log('\n 2. Sin contratos');
    ok(v.every((f) => f.reason === 'sin_contrato' && !f.supported), 'todos «sin contrato»: M1 = 0 %');

    console.log('\n 3. Cada motivo');
    await SQL.proponerDesdeLaHistoria(trx, T, 'prueba');
    v = await leer();
    ok(['capital', 'interes', 'domi'].every((c) => JSON.stringify(motivosDe(v, c)) === '["propuesta_sin_confirmar"]') && JSON.stringify(motivosDe(v, 'apertura')) === '["sin_contrato"]',
      'propuestos: los de serie quedan «propuesta sin confirmar»; la apertura (sin serie), «sin contrato»');
    const contratos = (await trx.raw(`SELECT id::text, creditor_name FROM finance.charge_contracts WHERE charge_bank_account_id = ?`, [cta.id])).rows;
    const domi = contratos.find((c) => /^DOMICILIACION/.test(c.creditor_name));
    const credito = contratos.find((c) => /^Crédito/.test(c.creditor_name));
    await SQL.confirmarContrato(trx, T, domi.id, 'tesoreria', { tipo: 'arrendamiento', acreedor: 'Arrendadora de prueba', documento: PDF });
    v = await leer();
    ok(deCaso(v, 'domi').every((f) => f.reason === 'con_contrato' && f.supported) && deCaso(v, 'domi').length === 6,
      '⭐ un contrato confirmado saca sus 6 cargos de la lista: «con contrato»');
    await SQL.cancelarContrato(trx, T, credito.id, 'tesoreria', 'el crédito va en un contrato a mano con su tabla');
    v = await leer();
    ok(JSON.stringify(motivosDe(v, 'interes')) === '["propuesta_rechazada"]', 'la propuesta rechazada: «propuesta rechazada» (sigue sin contrato)');

    // La disposición de BBVA: un contrato que empieza mañana, y luego uno vigente.
    const futura = await SQL.crearContrato(trx, T, 'tesoreria', { tipo: 'credito', acreedor: 'Línea BBVA (futura)', cuenta_id: cta.id, cadencia: 'mensual', dia_desde: 28, dia_hasta: 31, inicio: masDias(haceMeses(0, 1), 40),
      renglones: [{ concepto: 'interes', descripcion: 'Interés de la disposición', cabeza_banco: 'CREDITO LIQUIDO DISP', regla_importe: 'estimado' }] });
    await SQL.confirmarContrato(trx, T, futura, 'tesoreria', { documento: PDF });
    v = await leer();
    ok(JSON.stringify(motivosDe(v, 'bbva')) === '["fuera_de_vigencia"]', 'con un contrato que todavía no empieza: «fuera de vigencia»');
    const vigente = await SQL.crearContrato(trx, T, 'tesoreria', { tipo: 'credito', acreedor: 'Línea BBVA', cuenta_id: cta.id, cadencia: 'mensual', dia_desde: 28, dia_hasta: 31, inicio: haceMeses(6, 1),
      renglones: [{ concepto: 'interes', descripcion: 'Interés de la disposición', cabeza_banco: 'CREDITO LIQUIDO DISP', regla_importe: 'estimado' }] });
    await SQL.confirmarContrato(trx, T, vigente, 'tesoreria', { documento: PDF });
    v = await leer();
    ok(JSON.stringify(motivosDe(v, 'bbva')) === '["con_contrato"]' && deCaso(v, 'bbva').length === 1, 'con uno fuera de vigencia y otro vigente gana el vigente, y el cargo sale UNA vez');

    // La apertura con un importe distinto.
    const ap = await SQL.crearContrato(trx, T, 'tesoreria', { tipo: 'credito', acreedor: 'Apertura del crédito', cuenta_id: cta.id, cadencia: 'mensual', dia_desde: 20, dia_hasta: 20,
      renglones: [{ concepto: 'comision', descripcion: 'Comisión de apertura', cabeza_banco: 'COMISION DE PRESTAMO', regla_importe: 'fijo', importe_fijo: 90000 }] });
    await SQL.confirmarContrato(trx, T, ap, 'tesoreria', { documento: PDF });
    v = await leer();
    ok(JSON.stringify(motivosDe(v, 'apertura')) === '["importe_distinto"]', 'el contrato dice $90,000 y el banco cobró $99,000: «importe distinto»');

    // El capital por tabla: 4 pagos casan; uno está 20 días corrido.
    const tabla = [5, 4, 3, 2].map((k) => ({ fecha: masDias(haceMeses(k, 5), 3), importe: 83333.33 })).concat([{ fecha: masDias(haceMeses(1, 5), 20), importe: 83333.33 }]);
    const cap = await SQL.crearContrato(trx, T, 'tesoreria', { tipo: 'credito', acreedor: 'Crédito simple', cuenta_id: cta.id, cadencia: 'mensual', dia_desde: 5, dia_hasta: 7, inicio: haceMeses(6, 1),
      renglones: [{ concepto: 'capital', descripcion: 'Capital', cabeza_banco: 'PAGO DE CAPITAL', regla_importe: 'tabla', tabla }] });
    await SQL.confirmarContrato(trx, T, cap, 'tesoreria', { documento: PDF });
    v = await leer();
    const capV = deCaso(v, 'capital');
    ok(capV.filter((f) => f.reason === 'con_contrato').length === 4 && capV.filter((f) => f.reason === 'importe_distinto').length === 1,
      'por tabla: 4 pagos casan (importe ±$1, día ±10) y el que la tabla pone 20 días después: «importe distinto»');
    ok(JSON.stringify(motivosDe(v, 'interes')) === '["propuesta_rechazada"]', 'NEGATIVA: el contrato del capital no sustenta los intereses (otra cabeza)');

    const tot = v.reduce((t, f) => t + f.amount, 0), sus = v.filter((f) => f.supported).reduce((t, f) => t + f.amount, 0);
    console.log(`    → M1 en la prueba: ${(sus / tot * 100).toFixed(1)} % sustentado (${v.filter((f) => f.supported).length} de ${v.length})`);
    ok(v.every((f) => MIG.MOTIVOS.includes(f.reason)) && v.every((f) => f.supported === (f.reason === 'con_contrato')), 'todo motivo está en el catálogo y sólo «con contrato» sustenta');
    ok(new Set(v.map((f) => f.id)).size === v.length, 'cada movimiento una vez, con todos los contratos encima');

    console.log('\n 4. RLS');
    if (comoRuntime) {
      await trx.raw(`SET LOCAL app.tenant_id = '${OTRO}'`);
      const ven = Number((await trx.raw(`SELECT count(*)::int AS n FROM ${MIG.VISTA}`)).rows[0].n);
      ok(ven === 0, `otro tenant no ve ningún cargo (${ven})`);
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    }
  } catch (e) {
    fail++; console.error('  ✗ ERROR:', e.message);
  } finally {
    await trx.rollback().catch(() => {});
  }
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
