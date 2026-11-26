#!/usr/bin/env node
/**
 * `[PGP.219]` C1 — EL INTERÉS DEL CRÉDITO, CALCULADO Y RECALCULADO UN DÍA ANTES — `generarCargosDelMes`,
 * `recalcularInteresesDelCredito` y `cerrarCargosCobrados` (`cargo-del-mes.sql.ts`, TS cargado tal cual) contra Postgres
 * real, con los contratos PROPUESTOS desde la historia del banco y confirmados por los caminos de `[PGP.210]`.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. Dos créditos en la MISMA cuenta, con los mismos conceptos («pago de capital», «pago de intereses», «intereses no
 *     reales», «pago de IVA») y distinto número: el sistema propone uno por número, con 4 renglones que citan su serie.
 *  2. **Generar:** el interés real, el no real y el IVA de cada crédito salen CALCULADOS (saldo × tasa implícita × días,
 *     con el día del contrato aunque el banco haya cobrado el 6 o el 7), contra la aritmética de la prueba ±$0.10; la
 *     nota y la bitácora lo dicen. Los dos créditos no se mezclan.
 *  3. **NEGATIVA:** un crédito cuya tasa cambia cada mes no se calcula: queda lo último cobrado y la nota dice por qué.
 *  4. **Un día antes:** llega el cobro de este mes con otra tasa → el pendiente del mes siguiente se recalcula con la
 *     nueva (antes y después en la bitácora); el otro crédito, misma tasa, conserva su interés total. Recalcular dos
 *     veces no cambia nada.
 *  5. **Cerrar:** cada cobro cierra el cargo de SU crédito (la liga de `[PGP.212]` no confunde dos créditos de la misma
 *     cuenta con los mismos conceptos).
 *
 * Todo dentro de una transacción que se REVIERTE. ⚠️ Sin las migraciones de PGP.209, 210, 212 y 211: 2 = NO MEDIDO.
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
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp219-interes-del-credito', { url: DST });

const LIB = path.resolve(__dirname, '../../libs/finance/src/lib');
const SQL = require(path.join(LIB, 'charge-contracts/contratos-de-cargo.sql.ts'));
const MES = require(path.join(LIB, 'charge-contracts/cargo-del-mes.sql.ts'));
const T = '00000000-0000-0000-0000-00000000d01c';
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
const mesMas = (periodo, k) => { const [a, m] = periodo.split('-').map(Number); const n = m - 1 + k; return `${a + Math.floor(n / 12)}-${String(((n % 12) + 12) % 12 + 1).padStart(2, '0')}`; };
const r2 = (n) => Math.round(n * 100) / 100;
// La aritmética de la prueba, independiente de la regla: días del día 5 de un mes al día 5 del siguiente.
const diasP = (p) => Math.round((Date.parse(`${p}-05T00:00:00Z`) - Date.parse(`${mesMas(p, -1)}-05T00:00:00Z`)) / 86_400_000);
const cerca = (a, b, t = 0.1) => Math.abs(Number(a) - Number(b)) <= t;

(async () => {
  console.log('\n[PGP.219] el interés del crédito, calculado y recalculado un día antes — caminos reales, transacción que se revierte\n');
  let hay;
  try {
    hay = (await knex.raw(`SELECT to_regclass('finance.v_automatic_bank_charges') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'financial_commitments' AND column_name = 'contract_line_id') AS t`)).rows[0].t;
  } catch (e) { noMedido(`no hay Postgres: ${e.message}`); return salir(); }
  if (!hay) { noMedido('faltan las migraciones de PGP.212 o PGP.211'); return salir(); }

  const trx = await knex.transaction();
  try {
    await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    const hoy = (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const P0 = hoy.slice(0, 7), P1 = mesMas(P0, 1);
    const [cta] = (await trx.raw(`INSERT INTO finance.bank_accounts (tenant_id, bank, account_label, kind) VALUES (?, 'BANCO PRUEBA', '9219', 'bank') RETURNING id::text`, [T])).rows;
    const [est] = (await trx.raw(`INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period) VALUES (?, ?, 'prueba-pgp219') RETURNING id::text`, [T, cta.id])).rows;
    let n = 0;
    const mov = async (fecha, importe, concepto) => (await trx.raw(`INSERT INTO finance.bank_movements (tenant_id, statement_id, bank_account_id, movement_date, client_uuid, concept, amount_in, amount_out, sync_source)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'upload') RETURNING id::text`, [T, est.id, cta.id, fecha, `pgp219-${++n}`, concepto, importe])).rows[0].id;

    // La historia: 5 meses (P0-5 … P0-1). El banco cobra el día 5, salvo dos meses (el 6 y el 7): el periodo es del contrato.
    const DIA_COBRO = { [-4]: '06', [-2]: '07' };
    const INFL = [0.003, 0.001, 0.002, 0.0035, 0.0045];
    const credito = (num, capital, saldo0, tasaDe) => ({ num, capital, saldo0, tasaDe });
    const X = credito('087654321', 100000, 1500000, () => 0.15);
    const Y = credito('076543210', 50000, 600000, () => 0.18);
    const Z = credito('065432109', 10000, 100000, (k) => [0.15, 0.12, 0.17][k + 3]); // 3 meses, tasa distinta cada mes
    const cobro = (c, k, tasa, infl) => {
      const p = mesMas(P0, k);
      const saldo = c.saldo0 - c.capital * (k + 5);
      const interes = r2(saldo * tasa / 360 * diasP(p));
      const noReal = r2(saldo * infl);
      const real = r2(interes - noReal);
      return { p, saldo, interes, noReal, real, iva: r2(real * 0.16) };
    };
    const sembrar = async (c, k, tasa, infl, dia = '05') => {
      const x = cobro(c, k, tasa, infl);
      const f = `${x.p}-${dia}`;
      await mov(f, c.capital, `PAGO DE CAPITAL ${c.num}`);
      await mov(f, x.real, `PAGO DE INTERESES ${c.num}`);
      await mov(f, x.noReal, `INTERESES NO REALES ${c.num}`);
      await mov(f, x.iva, `PAGO DE IVA ${c.num}`);
      return x;
    };
    for (let k = -5; k <= -1; k++) {
      await sembrar(X, k, X.tasaDe(k), INFL[k + 5], DIA_COBRO[k]);
      await sembrar(Y, k, Y.tasaDe(k), INFL[k + 5], DIA_COBRO[k]);
      if (k >= -3) await sembrar(Z, k, Z.tasaDe(k), INFL[k + 5]);
    }

    let comoRuntime = false;
    try { await trx.raw('SET LOCAL ROLE app_runtime'); comoRuntime = (await trx.raw('SELECT current_user AS u')).rows[0].u === 'app_runtime'; } catch { /* se declara */ }
    if (!comoRuntime) noMedido('esta conexión no puede volverse app_runtime: se prueba con otro rol');

    console.log(' 1. La propuesta desde la historia');
    await SQL.proponerDesdeLaHistoria(trx, T, 'sistema:propuesta');
    const propuestas = (await trx.raw(`SELECT c.id::text AS id, c.creditor_name, c.kind, c.day_from, c.day_to,
        json_agg(json_build_object('concepto', l.concept, 'cabeza', l.bank_concept_head, 'regla', l.amount_rule, 'importe', l.fixed_amount, 'serie', l.series_key) ORDER BY l.sort_order) AS renglones
       FROM finance.charge_contracts c JOIN finance.charge_contract_lines l ON l.contract_id = c.id
      WHERE c.charge_bank_account_id = ? AND c.kind = 'credito' GROUP BY c.id`, [cta.id])).rows;
    const de = (c) => propuestas.find((p) => p.creditor_name.includes(c.num));
    ok(propuestas.length === 3 && [X, Y, Z].every((c) => de(c)), `3 créditos propuestos en la misma cuenta, uno por número (${propuestas.length})`);
    const pX = de(X);
    ok(pX && pX.renglones.length === 4 && pX.renglones.every((r) => r.serie) && pX.day_from === 5 && pX.day_to === 7
      && pX.renglones.find((r) => r.concepto === 'capital')?.regla === 'fijo' && pX.renglones.filter((r) => r.regla === 'estimado').length === 3,
    'cada uno con 4 renglones que citan su serie: capital fijo; interés, no reales e IVA estimados; días 5 a 7');
    for (const c of [X, Y, Z]) await SQL.confirmarContrato(trx, T, de(c).id, 'tesoreria', { documento: PDF });

    console.log('\n 2–3. Generar: el interés calculado');
    const r1 = await MES.generarCargosDelMes(trx, T, 'sistema:cargos', hoy);
    const lineas = (await trx.raw(`SELECT l.id::text AS id, l.contract_id::text AS contrato, l.bank_concept_head AS cabeza FROM finance.charge_contract_lines l
       JOIN finance.charge_contracts c ON c.id = l.contract_id WHERE c.charge_bank_account_id = ?`, [cta.id])).rows;
    const lineaId = (c, cabeza) => lineas.find((l) => l.contrato === de(c).id && l.cabeza === cabeza)?.id;
    const cargo = (c, p, cabeza) => r1.generados.find((g) => g.periodo === p && g.renglon_id === lineaId(c, cabeza));
    const esperado = (c, p, tasa, inflUltima) => {
      const k = Number(p.slice(0, 4)) * 12 + Number(p.slice(5)) - (Number(P0.slice(0, 4)) * 12 + Number(P0.slice(5)));
      const saldo = c.saldo0 - c.capital * (k + 5);
      const interes = r2(saldo * tasa / 360 * diasP(p));
      const noReal = r2(saldo * inflUltima);
      const real = r2(interes - noReal);
      return { saldo, interes, noReal, real, iva: r2(real * 0.16) };
    };
    for (const [c, tasa, nombre] of [[X, 0.15, 'X'], [Y, 0.18, 'Y']]) {
      for (const p of [P0, P1]) {
        const e = esperado(c, p, tasa, INFL[4]);
        const real = cargo(c, p, 'PAGO DE INTERESES'), nr = cargo(c, p, 'INTERESES NO REALES'), iva = cargo(c, p, 'PAGO DE IVA');
        ok(real && nr && iva && real.interes_calculado && nr.interes_calculado && iva.interes_calculado
          && cerca(real.importe + nr.importe, e.interes) && cerca(nr.importe, e.noReal) && cerca(real.importe, e.real) && cerca(iva.importe, e.iva),
        `${nombre} ${p}: interés ${real && nr ? r2(real.importe + nr.importe) : '—'} (esperado ${e.interes} = ${e.saldo} × ${tasa * 100} % × ${diasP(p)} días / 360), no real ${nr?.importe} (${e.noReal}), real ${real?.importe} (${e.real}), IVA ${iva?.importe} (${e.iva})`);
      }
    }
    const capX = cargo(X, P1, 'PAGO DE CAPITAL');
    ok(capX && capX.importe === 100000 && !capX.interes_calculado, 'el capital sigue siendo el fijo del contrato');
    const fcX = (await trx.raw(`SELECT fc.notes, h.detail FROM finance.financial_commitments fc
        JOIN finance.payment_allocation_items i ON i.obligation_id = fc.id JOIN finance.payment_allocation_history h ON h.allocation_id = i.allocation_id
       WHERE i.allocation_id = ? AND h.event = ?`, [cargo(X, P1, 'PAGO DE INTERESES').allocation_id, MES.EVENTO_PROGRAMADO_POR_CONTRATO])).rows[0];
    ok(fcX && fcX.notes === MES.NOTA_INTERES_CALCULADO && fcX.detail?.calculo && cerca(fcX.detail.calculo.tasa_anual, 0.15, 0.0001) && cerca(fcX.detail.calculo.saldo, 900000, 15),
      `la nota dice que es calculado y la bitácora guarda saldo (${fcX?.detail?.calculo?.saldo}), tasa (${fcX?.detail?.calculo?.tasa_anual}) y días`);
    const zReal = cargo(Z, P0, 'PAGO DE INTERESES');
    const zNota = zReal && (await trx.raw(`SELECT fc.notes FROM finance.financial_commitments fc JOIN finance.payment_allocation_items i ON i.obligation_id = fc.id WHERE i.allocation_id = ?`, [zReal.allocation_id])).rows[0]?.notes;
    const zUltimo = cobro(Z, -1, 0.17, INFL[4]).real;
    ok(zReal && !zReal.interes_calculado && zReal.importe === zUltimo && /lo último que cobró el banco/.test(zNota) && /misma tasa/.test(zNota),
      `NEGATIVA: Z (tasa distinta cada mes) no se calcula: lo último cobrado (${zReal?.importe} = ${zUltimo}) y la nota dice por qué`);
    const r2g = await MES.generarCargosDelMes(trx, T, 'sistema:cargos', hoy);
    ok(r2g.generados.length === 0, `generar dos veces = las mismas filas (${r2g.generados.length} nuevos)`);

    console.log('\n 4. Un día antes: llega el cobro de este mes, con otra tasa para X');
    const x0 = await sembrar(X, 0, 0.14, 0.004);
    await sembrar(Y, 0, 0.18, 0.004);
    const visperaP1 = (await trx.raw(`SELECT to_char(?::date - 1, 'YYYY-MM-DD') AS d`, [`${P1}-05`])).rows[0].d;
    const dosDiasAntes = (await trx.raw(`SELECT to_char(?::date - 2, 'YYYY-MM-DD') AS d`, [`${P1}-05`])).rows[0].d;
    const rcTemprano = await MES.recalcularInteresesDelCredito(trx, T, 'sistema:cargos', dosDiasAntes);
    ok(!rcTemprano.recalculados.some((x) => x.periodo === P1),
      `NEGATIVA: dos días antes (${dosDiasAntes}) el cargo de ${P1} todavía no se recalcula, aunque ya llegó el cobro nuevo (sólo un día antes)`);
    const rc = await MES.recalcularInteresesDelCredito(trx, T, 'sistema:cargos', visperaP1);
    const de1 = (c, cabeza) => rc.recalculados.find((x) => x.renglon_id === lineaId(c, cabeza) && x.periodo === P1);
    const eX = esperado(X, P1, 0.14, 0.004);
    const xr = de1(X, 'PAGO DE INTERESES'), xn = de1(X, 'INTERESES NO REALES'), xi = de1(X, 'PAGO DE IVA');
    ok(xr && xn && xi && cerca(xr.despues + xn.despues, eX.interes) && cerca(xi.despues, eX.iva) && xr.antes !== xr.despues,
      `X ${P1} recalculado con la tasa del último cobro (14 %): interés ${xr && xn ? r2(xr.despues + xn.despues) : '—'} (esperado ${eX.interes}), IVA ${xi?.despues} (${eX.iva}); antes ${xr?.antes}`);
    const yr = de1(Y, 'PAGO DE INTERESES'), yn = de1(Y, 'INTERESES NO REALES');
    const eY = esperado(Y, P1, 0.18, 0.004);
    const yTotal = r2((yr?.despues ?? cargo(Y, P1, 'PAGO DE INTERESES').importe) + (yn?.despues ?? cargo(Y, P1, 'INTERESES NO REALES').importe));
    ok(cerca(yTotal, eY.interes) && cerca(yn?.despues ?? -1, eY.noReal),
      `Y (misma tasa) conserva su interés total (${yTotal} = ${eY.interes}); sólo cambia el reparto por la inflación del último cobro (no real ${yn?.despues} = ${eY.noReal})`);
    ok(!rc.recalculados.some((x) => x.periodo === P0), `los cargos de ${P0} (su historia no cambió) no se tocan`);
    const hist = xr && (await trx.raw(`SELECT detail FROM finance.payment_allocation_history WHERE allocation_id = ? AND event = ?`, [xr.allocation_id, MES.EVENTO_RECALCULADO_POR_CONTRATO])).rows[0]?.detail;
    const estado = xr && (await trx.raw(`SELECT a.amount_assigned::float AS asignado, fc.original_amount::float AS original, fc.reserved_amount::float AS reservado, i.applied_amount::float AS aplicado
        FROM finance.payment_allocations a JOIN finance.payment_allocation_items i ON i.allocation_id = a.id JOIN finance.financial_commitments fc ON fc.id = i.obligation_id WHERE a.id = ?`, [xr.allocation_id])).rows[0];
    ok(hist && hist.antes === xr.antes && hist.despues === xr.despues && hist.calculo && estado && estado.asignado === xr.despues && estado.original === xr.despues && estado.aplicado === xr.despues && estado.reservado === xr.despues,
      'la bitácora guarda antes, después y el cálculo; pago, renglón del pago, compromiso y reserva quedan en el nuevo importe');
    const rc2 = await MES.recalcularInteresesDelCredito(trx, T, 'sistema:cargos', visperaP1);
    ok(rc2.recalculados.length === 0 && rc2.revisados > 0, `recalcular dos veces no cambia nada (${rc2.recalculados.length} de ${rc2.revisados})`);

    console.log('\n 5. Cerrar: cada cobro, con SU crédito');
    const c = await MES.cerrarCargosCobrados(trx, T, 'sistema:cargos');
    const cerradoDe = (cr, cabeza) => c.cerrados.find((x) => x.renglon_id === lineaId(cr, cabeza) && x.periodo === P0);
    const xc = cerradoDe(X, 'PAGO DE INTERESES'), yc = cerradoDe(Y, 'PAGO DE INTERESES');
    ok(xc && yc && xc.importe === x0.real && yc.importe === cobro(Y, 0, 0.18, 0.004).real,
      `el «pago de intereses» de X cierra con el de X (${xc?.importe} = ${x0.real}) y el de Y con el de Y (${yc?.importe}): dos créditos de la misma cuenta no se cruzan`);
    const ligas = (await trx.raw(`SELECT ac.contract_id::text AS contrato, ac.concept FROM finance.v_automatic_bank_charges ac WHERE ac.bank_account_id = ? AND ac.reason = 'con_contrato'`, [cta.id])).rows;
    const cruzadas = ligas.filter((l) => { const num = (/\d{6,}/.exec(l.concept) || [])[0]; return [X, Y, Z].some((cr) => cr.num === num && de(cr).id !== l.contrato); });
    ok(ligas.length > 0 && cruzadas.length === 0, `en la vista de PGP.212, ningún cobro queda ligado al contrato del otro crédito (${cruzadas.length} de ${ligas.length})`);
  } catch (e) {
    fail++; console.error('  ✗ ERROR:', e.stack || e.message);
  } finally {
    await trx.rollback().catch(() => {});
  }
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
