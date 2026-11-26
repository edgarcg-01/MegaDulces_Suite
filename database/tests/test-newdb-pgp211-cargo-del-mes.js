#!/usr/bin/env node
/**
 * `[PGP.211]` EL CARGO DE CADA MES DE UN CONTRATO, EN EL CALENDARIO — `generarCargosDelMes` y `cerrarCargosCobrados`
 * (`cargo-del-mes.sql.ts`, TS cargado tal cual) contra Postgres real, con los contratos escritos por los caminos de
 * `[PGP.210]` y la liga de `[PGP.212]`.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **Genera** el cargo de este mes y del siguiente de cada renglón confirmado: el compromiso (con contrato, renglón,
 *     periodo y base), su pago en el día esperado como `cargo_automatico` desde la cuenta del contrato, YA AUTORIZADO
 *     por el contrato (DCR5), la reserva recalculada y su bitácora. Fijo × cargos por periodo, tabla del mes, estimado =
 *     lo último que cobró el banco.
 *  2. **Lo que no genera, con su motivo:** ya cobrado este mes, acreedor en Kepler (no se duplica), semanal (nómina es
 *     PGP.215), contrato terminado, estimado sin cobro anterior.
 *  3. **Generar dos veces = las mismas filas.**
 *  4. **Cierra** con la liga de PGP.212, no por importe: con 1 de 2 cargos del periodo espera; con los 2, paga con el
 *     grupo; el estimado toma lo que cobró el banco; el de tabla casa ±10 días; un importe distinto no cierra; una salida
 *     ya ligada a otro pago no se toma. Cerrar dos veces no paga dos veces.
 *  5. **El aviso de PGP.218 no lo cuenta dos veces:** el cargo programado está en lo preparado y su serie sale de los
 *     «esperados por historia».
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas.
 * ⚠️ Sin las migraciones de PGP.209, 210, 212 y 211 sale con 2 = NO MEDIDO.
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
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp211-cargo-del-mes', { url: DST });

const LIB = path.resolve(__dirname, '../../libs/finance/src/lib');
const SQL = require(path.join(LIB, 'charge-contracts/contratos-de-cargo.sql.ts'));
const MES = require(path.join(LIB, 'charge-contracts/cargo-del-mes.sql.ts'));
const { leerEntradaDeSuficiencia } = require(path.join(LIB, 'payment-calendar/suficiencia-de-cuentas.query.ts'));
const { SQL_SALIDAS_LIGADAS } = require(path.join(LIB, 'payment-calendar/pago-por-el-banco.sql.ts'));
const { SUBTIPOS_COMPROMISO } = require(path.resolve(__dirname, '../../libs/contracts/src/finance/contratos-de-cargo.contract.ts'));
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

(async () => {
  console.log('\n[PGP.211] el cargo de cada mes de un contrato, en el Calendario — caminos reales, transacción que se revierte\n');
  let hay;
  try {
    hay = (await knex.raw(`SELECT to_regclass('finance.v_automatic_bank_charges') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'financial_commitments' AND column_name = 'contract_line_id') AS t`)).rows[0].t;
  } catch (e) { noMedido(`no hay Postgres: ${e.message}`); return salir(); }
  if (!hay) { noMedido('faltan las migraciones de PGP.212 o PGP.211'); return salir(); }
  const def = (await knex.raw(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'financial_commitments_subtype_check'`)).rows[0]?.d ?? '';
  const enCheck = [...def.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  ok(JSON.stringify(enCheck) === JSON.stringify([...SUBTIPOS_COMPROMISO].sort()), `los subtipos del código = los del CHECK (${enCheck.length})`);

  const trx = await knex.transaction();
  try {
    await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    const hoy = (await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    const P0 = hoy.slice(0, 7), P1 = mesMas(P0, 1), P2 = mesMas(P0, 2);
    const [cta] = (await trx.raw(`INSERT INTO finance.bank_accounts (tenant_id, bank, account_label, kind) VALUES (?, 'BANCO PRUEBA', '9211', 'bank') RETURNING id::text`, [T])).rows;
    const [est] = (await trx.raw(`INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period) VALUES (?, ?, 'prueba-pgp211') RETURNING id::text`, [T, cta.id])).rows;
    let n = 0;
    const mov = async (fecha, importe, concepto) => (await trx.raw(`INSERT INTO finance.bank_movements (tenant_id, statement_id, bank_account_id, movement_date, client_uuid, concept, amount_in, amount_out, sync_source)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'upload') RETURNING id::text`, [T, est.id, cta.id, fecha, `pgp211-${++n}`, concepto, importe])).rows[0].id;
    // Historia: 4 meses (3 atrás y éste) cobrados el día 1.
    const INT = [16076.30, 12693.40, 11500.00, 10529.50];
    for (let k = 3; k >= 0; k--) {
      const p = mesMas(P0, -k);
      await mov(`${p}-01`, 21291, 'DOMICILIACION PAGO SERVICIO');
      await mov(`${p}-01`, 21291, 'DOMICILIACION PAGO SERVICIO');
      await mov(`${p}-01`, 83333.33, 'PAGO DE CAPITAL 012345678');
      await mov(`${p}-01`, INT[3 - k], 'PAGO DE INTERESES 012345678');
    }

    let comoRuntime = false;
    try { await trx.raw('SET LOCAL ROLE app_runtime'); comoRuntime = (await trx.raw('SELECT current_user AS u')).rows[0].u === 'app_runtime'; } catch { /* se declara */ }
    if (!comoRuntime) noMedido('esta conexión no puede volverse app_runtime: se prueba con otro rol');

    const crear = async (d, conf = {}) => { const id = await SQL.crearContrato(trx, T, 'tesoreria', { cuenta_id: cta.id, cadencia: 'mensual', ...d }); await SQL.confirmarContrato(trx, T, id, 'tesoreria', conf); return id; };
    const seis = `${mesMas(P0, -6)}-01`;
    const A = await crear({ tipo: 'arrendamiento', acreedor: 'Arrendadora de prueba', dia_desde: 1, dia_hasta: 3, inicio: seis,
      renglones: [{ concepto: 'renta', descripcion: 'Renta', cabeza_banco: 'DOMICILIACION PAGO SERVICIO', regla_importe: 'fijo', importe_fijo: 21291, cargos_por_periodo: 2 }] }, { documento: PDF });
    const B = await crear({ tipo: 'credito', acreedor: 'Crédito de prueba', dia_desde: 1, dia_hasta: 3, inicio: seis, renglones: [
      { concepto: 'capital', descripcion: 'Capital', cabeza_banco: 'PAGO DE CAPITAL', regla_importe: 'tabla', tabla: [P0, P1, P2].map((p) => ({ fecha: `${p}-01`, importe: 83333.33 })) },
      { concepto: 'interes', descripcion: 'Interés', cabeza_banco: 'PAGO DE INTERESES', regla_importe: 'estimado' }] }, { documento: PDF });
    const C = await crear({ tipo: 'seguro', acreedor: 'Seguro con Kepler', dia_desde: 10, dia_hasta: 10, kepler_acreedor: 'GS012',
      renglones: [{ concepto: 'seguro', descripcion: 'Prima', cabeza_banco: 'PAGO SEGURO', regla_importe: 'estimado' }] }, { documento: PDF });
    const D = await crear({ tipo: 'nomina', acreedor: 'Nómina', cadencia: 'semanal', dia_desde: 5, dia_hasta: 5,
      renglones: [{ concepto: 'otro', descripcion: 'Nómina', regla_importe: 'fijo', importe_fijo: 1000 }] });
    const E = await crear({ tipo: 'cuota_comision', acreedor: 'Cuota terminada', dia_desde: 2, dia_hasta: 2, inicio: seis, fin: `${mesMas(P0, -1)}-28`,
      renglones: [{ concepto: 'comision', descripcion: 'Servicio de banca', cabeza_banco: 'COM SERV BBVA', regla_importe: 'fijo', importe_fijo: 830 }] });
    const F = await crear({ tipo: 'servicio', acreedor: 'Servicio sin historia', dia_desde: 8, dia_hasta: 8,
      renglones: [{ concepto: 'otro', descripcion: 'Teléfono', cabeza_banco: 'PAGO TELEFONO', regla_importe: 'estimado' }] });
    const G = await crear({ tipo: 'cuota_comision', acreedor: 'Cuota de manejo', dia_desde: 2, dia_hasta: 2, inicio: seis,
      renglones: [{ concepto: 'comision', descripcion: 'Manejo de cuenta', cabeza_banco: 'CARGO COBRANZA DOMICILIADA', regla_importe: 'fijo', importe_fijo: 5000 }] });

    console.log(' 1–3. Generar');
    const r1 = await MES.generarCargosDelMes(trx, T, 'sistema:cargos', hoy);
    const gen = (id) => r1.generados.filter((g) => g.contrato_id === id);
    const omi = (id) => r1.omitidos.filter((g) => g.contrato_id === id);
    ok(r1.generados.length === 5, `5 cargos generados (${r1.generados.length}): A ${P1}, el capital y el interés de B en ${P1}, G en ${P0} y ${P1}`);
    ok(gen(A).length === 1 && gen(A)[0].periodo === P1 && gen(A)[0].importe === 42582 && gen(A)[0].fecha === `${P1}-01` && gen(A)[0].base === 'fijo',
      `A: fijo × 2 cargos por periodo = $42,582 el ${P1}-01`);
    ok(omi(A).length === 1 && omi(A)[0].periodo === P0 && /ya lo cobró/.test(omi(A)[0].motivo), `A: ${P0} no se programa: el banco ya lo cobró`);
    const bCap = gen(B).find((g) => g.base === 'tabla'), bInt = gen(B).find((g) => g.base === 'estimado');
    ok(bCap?.importe === 83333.33 && bCap.fecha === `${P1}-01` && bInt?.importe === 10529.5 && bInt.periodo === P1,
      'B: el capital sale de su tabla; el interés, estimado con lo último que cobró el banco ($10,529.50)');
    ok(omi(C).length === 2 && omi(C).every((o) => /Kepler/.test(o.motivo)), 'C: con acreedor en Kepler no se genera (no se duplica)');
    ok(omi(D).length === 2 && omi(D).every((o) => /semanal/.test(o.motivo)), 'D: la nómina semanal es PGP.215');
    ok(omi(E).length === 2 && omi(E).every((o) => /terminó/.test(o.motivo)), 'E: el contrato terminado no genera');
    ok(omi(F).length === 2 && omi(F).every((o) => /sin un cobro anterior/.test(o.motivo)), 'F: el estimado sin historia se dice, no se inventa');
    ok(gen(G).length === 2 && gen(G).every((g) => g.importe === 5000), `G: cobra el día 2 y no se ha cobrado: ${P0} y ${P1}`);

    const pagoA = (await trx.raw(`SELECT a.status, a.payment_method, a.bank_account_id::text AS cuenta, a.authorized_by, a.authorized_at IS NOT NULL AS autorizado,
        a.amount_assigned::float AS asignado, a.classification, to_char(l.lot_date, 'YYYY-MM-DD') AS dia,
        fc.subtype, fc.status AS fc_status, fc.reserved_amount::float AS reservado, fc.contract_id::text AS contrato, fc.period, fc.amount_basis,
        (SELECT count(*)::int FROM finance.payment_allocation_history h WHERE h.allocation_id = a.id AND h.event = ?) AS bitacora
       FROM finance.payment_allocations a JOIN finance.payment_calendar_lots l ON l.id = a.lot_id
       JOIN finance.payment_allocation_items i ON i.allocation_id = a.id JOIN finance.financial_commitments fc ON fc.id = i.obligation_id
      WHERE a.id = ?`, [MES.EVENTO_PROGRAMADO_POR_CONTRATO, gen(A)[0].allocation_id])).rows[0];
    ok(pagoA.status === 'pending' && pagoA.payment_method === 'cargo_automatico' && pagoA.cuenta === cta.id && pagoA.dia === `${P1}-01` && pagoA.classification === 'compromiso_financiero',
      'el pago: pendiente, cargo automático desde la cuenta del contrato, en su día');
    ok(pagoA.authorized_by === `contrato:${A}` && pagoA.autorizado, 'DCR5: ya autorizado, y la firma es la del contrato');
    ok(pagoA.subtype === 'arrendamiento' && pagoA.fc_status === 'partial' && pagoA.reservado === 42582 && pagoA.contrato === A && pagoA.period === P1 && pagoA.amount_basis === 'fijo' && pagoA.bitacora === 1,
      'el compromiso: subtipo, reservado por su pago (recálculo del Calendario), contrato, periodo, base y bitácora');
    const subs = (await trx.raw(`SELECT DISTINCT subtype FROM finance.financial_commitments WHERE contract_id = ANY(?::uuid[]) ORDER BY 1`, [[A, B, G]])).rows.map((x) => x.subtype);
    ok(JSON.stringify(subs) === JSON.stringify(['amortizacion', 'arrendamiento', 'cuota_comision', 'interes']), `subtipos: ${subs.join(', ')}`);

    const r2 = await MES.generarCargosDelMes(trx, T, 'sistema:cargos', hoy);
    ok(r2.generados.length === 0 && r2.ya_estaban === 5, `generar dos veces = las mismas filas (${r2.generados.length} nuevos, ${r2.ya_estaban} ya estaban)`);

    console.log('\n 5. El aviso de PGP.218 no lo cuenta dos veces');
    // El aviso se lee el día anterior al cargo de A: su ventana de 7 días lo alcanza sea cual sea el día de hoy.
    const vispera = (await trx.raw(`SELECT to_char(?::date - 1, 'YYYY-MM-DD') AS d`, [`${P1}-01`])).rows[0].d;
    const ent = await leerEntradaDeSuficiencia(trx, T, vispera);
    const serieA = (await trx.raw(`SELECT DISTINCT series_key FROM finance.v_automatic_bank_charges WHERE bank_account_id = ? AND concept_head = 'DOMICILIACION PAGO SERVICIO' AND series_key IS NOT NULL`, [cta.id])).rows.map((x) => x.series_key);
    // Control: sin el filtro, la serie SÍ estaría (vigente y con su próximo cargo dentro de la ventana).
    const cruda = (await trx.raw(`SELECT count(*)::int AS n FROM finance.v_recurring_bank_charges WHERE series_key = ANY(?::text[]) AND is_active AND next_expected_date <= ?`, [serieA, ent.hasta])).rows[0].n;
    ok(serieA.length >= 1 && cruda >= 1, `control: la serie de la arrendadora existe y vence dentro de la ventana (${serieA.length} serie, ${cruda} vigente)`);
    ok(!ent.series.some((s) => serieA.includes(s.series_key)), 'la serie de la arrendadora ya no es «esperado por historia»: su cargo está programado');
    ok(ent.pagos.some((p) => p.allocation_id === gen(A)[0].allocation_id && p.importe === 42582), 'y el cargo programado sí está en lo que sale de la cuenta');
    const serieB = (await trx.raw(`SELECT DISTINCT series_key FROM finance.v_automatic_bank_charges WHERE bank_account_id = ? AND concept_head = 'PAGO DE INTERESES' AND series_key IS NOT NULL`, [cta.id])).rows.map((x) => x.series_key);
    ok(!ent.series.some((s) => serieB.includes(s.series_key)), 'lo mismo con el interés estimado del crédito');

    console.log('\n 4. Cerrar cuando el banco cobra');
    await mov(`${P1}-02`, 21291, 'DOMICILIACION PAGO SERVICIO');
    let c = await MES.cerrarCargosCobrados(trx, T, 'sistema:cargos');
    ok(c.esperando.some((e) => e.allocation_id === gen(A)[0].allocation_id && /1 de 2/.test(e.motivo)), 'A con 1 de 2 cargos del periodo: espera');
    const a2 = await mov(`${P1}-03`, 21291, 'DOMICILIACION PAGO SERVICIO');
    await mov(`${P1}-05`, 9800, 'PAGO DE INTERESES 012345678');
    await mov(`${P1}-04`, 83333.33, 'PAGO DE CAPITAL 012345678');
    await mov(`${P1}-02`, 5100, 'CARGO COBRANZA DOMICILIADA MANEJO');
    // Una salida de G por su importe exacto, pero YA ligada a otro pago: no se toma.
    const ligada = await mov(`${P1}-02`, 5000, 'CARGO COBRANZA DOMICILIADA MANEJO');
    const [lot] = (await trx.raw(`SELECT id FROM finance.payment_calendar_lots WHERE tenant_id = ? AND lot_date = ?`, [T, `${P1}-01`])).rows;
    await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot.id, classification: 'gasto', amount_assigned: 5000, status: 'executed', paid_bank_movement_id: ligada, created_by: 'prueba' });
    c = await MES.cerrarCargosCobrados(trx, T, 'sistema:cargos');
    const cerr = (id) => c.cerrados.find((x) => x.allocation_id === id);
    const cA = cerr(gen(A)[0].allocation_id);
    ok(cA && cA.movimientos.length === 2 && cA.importe === 42582 && cA.movimientos.includes(a2), 'A con los 2 cargos: pagado con el grupo de 2 salidas');
    const cI = cerr(bInt.allocation_id), cK = cerr(bCap.allocation_id);
    ok(cI?.importe === 9800, 'el interés estimado toma lo que cobró el banco ($9,800)');
    ok(!!cK, 'el capital por tabla casa con su salida (3 días después de su fila)');
    const gP1 = gen(G).find((g) => g.periodo === P1);
    ok(c.esperando.some((e) => e.allocation_id === gP1.allocation_id) && !cerr(gP1.allocation_id), 'NEGATIVA: G no cierra con un importe distinto ni con una salida ya ligada a otro pago');
    const estado = (await trx.raw(`SELECT a.status, a.amount_assigned::float AS asignado, a.paid_bank_amount::float AS pagado_banco, fc.status AS fc, fc.paid_amount::float AS pagado,
        fc.original_amount::float AS original FROM finance.payment_allocations a JOIN finance.payment_allocation_items i ON i.allocation_id = a.id
        JOIN finance.financial_commitments fc ON fc.id = i.obligation_id WHERE a.id = ?`, [bInt.allocation_id])).rows[0];
    ok(estado.status === 'executed' && estado.asignado === 9800 && estado.pagado_banco === 9800 && estado.fc === 'paid' && estado.pagado === 9800 && estado.original === 9800,
      'el estimado cerrado: pago, compromiso y su original quedan en lo que cobró el banco, y el compromiso pagado');
    const hist = (await trx.raw(`SELECT detail FROM finance.payment_allocation_history WHERE allocation_id = ? AND event = ?`, [gen(A)[0].allocation_id, MES.EVENTO_PAGADO_POR_CONTRATO])).rows[0]?.detail;
    ok(Array.isArray(hist?.banco?.grupo) && hist.banco.grupo.length === 2, 'la bitácora guarda el grupo de salidas');
    const ligadasAhora = new Set((await trx.raw(SQL_SALIDAS_LIGADAS, [T])).rows.map((x) => x.id));
    ok(cA && cA.movimientos.every((m) => ligadasAhora.has(m)), 'las DOS salidas de A son salidas ligadas para PGP.121: ningún otro pago por $21,291 se queda con la segunda');
    const c2 = await MES.cerrarCargosCobrados(trx, T, 'sistema:cargos');
    ok(c2.cerrados.length === 0, 'cerrar dos veces no paga dos veces');
    await mov(`${P1}-03`, 5000, 'CARGO COBRANZA DOMICILIADA MANEJO');
    const c3 = await MES.cerrarCargosCobrados(trx, T, 'sistema:cargos');
    ok(c3.cerrados.some((x) => x.allocation_id === gP1.allocation_id), 'con una salida libre por su importe, G sí cierra');
  } catch (e) {
    fail++; console.error('  ✗ ERROR:', e.message);
  } finally {
    await trx.rollback().catch(() => {});
  }
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
