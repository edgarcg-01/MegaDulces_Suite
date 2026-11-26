#!/usr/bin/env node
/**
 * `[PGP.210]` EL CONTRATO QUE SUSTENTA UN CARGO DEL BANCO — `finance.charge_contracts`, `_lines` y `_schedule`, con los
 * caminos REALES de escritura (`contratos-de-cargo.sql.ts`, TS cargado tal cual) contra Postgres real.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 *  1. **Las listas del código = los CHECK** (tipo, estado, origen, cadencia, concepto, regla de importe).
 *  2. **El sistema propone** (DCR1) desde la historia del banco sembrada: el crédito agrupa capital + interés por su
 *     número; la domiciliación queda «por clasificar» con 2 cargos por periodo; la comisión y su IVA se clasifican
 *     solos; cada uno con su evidencia. **Proponer dos veces no propone dos veces.**
 *  3. **Tesorería confirma**: sin clasificar se niega con lo que falta (en llano); con la corrección, confirma y deja
 *     quién. Confirmar dos veces, terminar sin confirmar o cancelar uno confirmado se niega.
 *  4. **Rechazar** una propuesta (con motivo) no la vuelve a proponer. **Terminar** deja motivo y fecha de fin.
 *  5. **El alta a mano**: un crédito con interés de tasa variable (referencia, puntos, base) y capital por tabla; la
 *     tabla vacía no deja confirmar.
 *  6. **Negativas, una por CHECK**, y el tenant cruzado por la llave compuesta.
 *  7. **Como `app_runtime`**: no borra contratos ni renglones (sí reemplaza la tabla); otro tenant no ve nada (RLS).
 *
 * Todo dentro de una transacción que se REVIERTE: no deja filas.
 * ⚠️ Sin las tablas (migraciones 20261126001551 y la vista de 20261125224611 sin aplicar) sale con 2 = NO MEDIDO.
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
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp210-charge-contracts', { url: DST });

const SQL = require(path.resolve(__dirname, '../../libs/finance/src/lib/charge-contracts/contratos-de-cargo.sql.ts'));
const CONTRATO = path.resolve(__dirname, '../../libs/contracts/src/finance/contratos-de-cargo.contract.ts');
const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000ab';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const knex = require('knex')({ client: 'pg', connection: { connectionString: DST }, pool: { min: 1, max: 2 } });
const salir = async () => {
  await knex.destroy();
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};

/** Las listas del contrato, leídas del CÓDIGO (no copiadas aquí: una copia se queda vieja). */
function listasDelContrato() {
  const src = fs.readFileSync(CONTRATO, 'utf8');
  const lista = (nombre) => {
    const m = src.match(new RegExp(`export const ${nombre}: readonly \\w+\\[\\] = \\[([^\\]]*)\\]`));
    if (!m) throw new Error(`no encontré ${nombre} en ${CONTRATO}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  return {
    kind: lista('TIPOS_CONTRATO_CARGO'), status: lista('ESTADOS_CONTRATO_CARGO'), origin: lista('ORIGENES_CONTRATO_CARGO'),
    cadence: lista('CADENCIAS_CONTRATO_CARGO'), concept: lista('CONCEPTOS_RENGLON_CARGO'), amount_rule: lista('REGLAS_IMPORTE_CARGO'),
  };
}

/** El día `dia` del mes `k` meses antes del actual (YYYY-MM-DD). */
function haceMeses(k, dia) {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); d.setUTCDate(dia);
  return d.toISOString().slice(0, 10);
}

(async () => {
  console.log('\n[PGP.210] el contrato que sustenta un cargo del banco — caminos reales, transacción que se revierte\n');
  let hay;
  try {
    hay = (await knex.raw(`SELECT to_regclass('finance.charge_contracts') IS NOT NULL AND to_regclass('finance.v_recurring_bank_charges') IS NOT NULL AS t`)).rows[0].t;
  } catch (e) { noMedido(`no hay Postgres: ${e.message}`); return salir(); }
  if (!hay) { noMedido('finance.charge_contracts o la vista de PGP.209 no existen (migraciones sin aplicar)'); return salir(); }

  // 1. Las listas del código = los CHECK.
  console.log(' 1. Las listas del código = los CHECK');
  const contrato = listasDelContrato();
  const defsDe = async (tabla) => (await knex.raw(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = ?::regclass AND contype = 'c'`, [tabla])).rows.map((r) => r.def);
  const valoresDe = (col, defs, filtro) => [...new Set(defs.filter((d) => !filtro || filtro(d)).flatMap((d) => {
    const out = [];
    for (const m of d.matchAll(new RegExp(`\\b${col} = ANY \\(ARRAY\\[([^\\]]+)\\]\\)`, 'g'))) out.push(...[...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    return out;
  }))].sort();
  const dC = await defsDe('finance.charge_contracts');
  const dL = await defsDe('finance.charge_contract_lines');
  for (const [col, defs] of [['kind', dC], ['status', dC], ['origin', dC], ['cadence', dC], ['concept', dL], ['amount_rule', dL]]) {
    // Sólo el CHECK de la lista (`<col> = ANY (...)` como TODA la expresión), no los que la mencionan de paso.
    const enCheck = valoresDe(col, defs, (d) => new RegExp(`^CHECK \\(\\(?${col} = ANY`).test(d));
    ok(JSON.stringify(enCheck) === JSON.stringify(contrato[col]), `${col}: el código y el CHECK aceptan lo mismo (${contrato[col].join(', ')})${JSON.stringify(enCheck) === JSON.stringify(contrato[col]) ? '' : ` — CHECK: ${enCheck.join(', ')}`}`);
  }

  const trx = await knex.transaction();
  const sp = async (nombre, fn) => {
    await trx.raw(`SAVEPOINT ${nombre}`);
    try { return await fn(); } finally { await trx.raw(`ROLLBACK TO SAVEPOINT ${nombre}`); }
  };
  /** Una sentencia que TIENE que rebotar con `codigo` (23514 CHECK, 23505 único, 23503 llave, 42501 permiso). */
  const rebota = async (nombre, codigo, fn, msg) => {
    let got = null;
    try { await sp(nombre, fn); } catch (e) { got = e.code || e.message; }
    ok(got === codigo, `${msg} → ${got === codigo ? `rebota (${codigo})` : `NO rebota como se espera (${got})`}`);
  };
  try {
    await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    // Siembra (como el dueño): una cuenta, su estado de cuenta y la historia del banco.
    const [cta] = (await trx.raw(`INSERT INTO finance.bank_accounts (tenant_id, bank, account_label, kind) VALUES (?, 'BANCO PRUEBA', '9210', 'bank') RETURNING id::text`, [T])).rows;
    const [est] = (await trx.raw(`INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period) VALUES (?, ?, 'prueba-pgp210') RETURNING id::text`, [T, cta.id])).rows;
    let n = 0;
    const mov = (fecha, importe, concepto) => trx.raw(`INSERT INTO finance.bank_movements (tenant_id, statement_id, bank_account_id, movement_date, client_uuid, concept, amount_in, amount_out, sync_source)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'upload')`, [T, est.id, cta.id, fecha, `pgp210-${++n}`, concepto, importe]);
    const INT = [22013.10, 20486.20, 16076.30, 12693.40, 10529.50];
    for (let k = 5; k >= 1; k--) {
      await mov(haceMeses(k, 5), 83333.33, 'PAGO DE CAPITAL 012345678');
      await mov(haceMeses(k, 5), INT[5 - k], 'PAGO DE INTERESES 012345678');
    }
    for (let k = 3; k >= 1; k--) {
      await mov(haceMeses(k, 24), 21291, "DOMICILIACION PAGO SERVICIO '000" + k + "1 RFC AAA010101AAA");
      await mov(haceMeses(k, 27), 21291, 'DOMICILIACION PAGO SERVICIO');
      await mov(haceMeses(k, 2), 830, 'COM SERV BBVA');
      await mov(haceMeses(k, 2), 132.8, 'COBRO IVA COM SERV');
    }

    // Desde aquí, como el rol de prod.
    let comoRuntime = false;
    try { await trx.raw('SET LOCAL ROLE app_runtime'); comoRuntime = (await trx.raw('SELECT current_user AS u')).rows[0].u === 'app_runtime'; } catch { /* se declara */ }
    if (!comoRuntime) noMedido('esta conexión no puede volverse app_runtime: los permisos y la RLS no se prueban como el rol de prod');

    console.log('\n 2. El sistema propone (DCR1)');
    const r1 = await SQL.proponerDesdeLaHistoria(trx, T, 'prueba-pgp210');
    const contratos = (await trx.raw(`SELECT c.id::text, c.kind, c.creditor_name, c.status, c.origin, c.day_from, c.day_to, jsonb_array_length(c.evidence) AS evid,
        (SELECT json_agg(json_build_object('concepto', l.concept, 'regla', l.amount_rule, 'importe', l.fixed_amount::float, 'cargos', l.charges_per_period) ORDER BY l.sort_order)
           FROM finance.charge_contract_lines l WHERE l.contract_id = c.id) AS renglones
       FROM finance.charge_contracts c WHERE c.tenant_id = ? AND c.charge_bank_account_id = ?`, [T, cta.id])).rows;
    const de = (re) => contratos.find((c) => re.test(c.creditor_name));
    const credito = de(/^Crédito 012345678$/), domi = de(/^DOMICILIACION/), com = de(/^COM SERV/), iva = de(/^COBRO IVA/);
    ok(r1.contratos === 4 && r1.renglones === 5 && r1.ya_citadas === 0, `4 propuestas con 5 renglones de 5 series (${JSON.stringify(r1)})`);
    ok(credito && credito.kind === 'credito' && JSON.stringify(credito.renglones.map((x) => [x.concepto, x.regla])) === JSON.stringify([['capital', 'fijo'], ['interes', 'estimado']]) && credito.evid === 2,
      'el crédito: capital fijo + interés estimado del MISMO número, en UN contrato, con la evidencia de las 2 series');
    ok(domi && domi.kind === 'por_clasificar' && domi.renglones[0].importe === 21291 && domi.renglones[0].cargos === 2 && domi.status === 'propuesto' && domi.origin === 'historia',
      'la domiciliación: por clasificar (el banco no dice qué es), $21,291 con 2 cargos por periodo, propuesta por la historia');
    ok(com?.kind === 'cuota_comision' && iva?.kind === 'cuota_comision' && iva.renglones[0].concepto === 'iva', 'la comisión y su IVA se clasifican solos como cuota de comisión');
    const r2 = await SQL.proponerDesdeLaHistoria(trx, T, 'prueba-pgp210');
    ok(r2.contratos === 0 && r2.ya_citadas === r1.renglones, `proponer otra vez no propone nada (${JSON.stringify(r2)})`);

    console.log('\n 3. Tesorería confirma');
    const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    const e1 = await err(() => SQL.confirmarContrato(trx, T, domi.id, 'tesoreria'));
    ok(e1?.codigo === 'incompleto' && /Falta decir qué es/.test(e1.message), `sin clasificar no se confirma, y dice qué falta («${e1?.message?.slice(0, 50)}…»)`);
    await SQL.confirmarContrato(trx, T, domi.id, 'tesoreria', { tipo: 'arrendamiento', acreedor: 'Arrendadora de prueba', documento: { storage_key: 'contratos/prueba.pdf', nombre: 'prueba.pdf' } });
    const domiC = (await trx.raw(`SELECT status, kind, creditor_name, confirmed_by, confirmed_at IS NOT NULL AS cuando, document_name FROM finance.charge_contracts WHERE id = ?`, [domi.id])).rows[0];
    ok(domiC.status === 'confirmado' && domiC.kind === 'arrendamiento' && domiC.creditor_name === 'Arrendadora de prueba' && domiC.confirmed_by === 'tesoreria' && domiC.cuando && domiC.document_name === 'prueba.pdf',
      'con la corrección (tipo, acreedor, PDF) se confirma y deja quién y cuándo');
    const e2 = await err(() => SQL.confirmarContrato(trx, T, domi.id, 'tesoreria'));
    ok(e2?.codigo === 'transicion', 'confirmar dos veces se niega');
    const e3 = await err(() => SQL.cancelarContrato(trx, T, domi.id, 'tesoreria', 'ya no'));
    ok(e3?.codigo === 'transicion', 'un contrato confirmado no se rechaza: se termina');
    const e4 = await err(() => SQL.terminarContrato(trx, T, credito.id, 'tesoreria', 'se pagó'));
    ok(e4?.codigo === 'transicion', 'una propuesta no se termina: se confirma o se rechaza');
    const e5 = await err(() => SQL.confirmarContrato(trx, T, '00000000-0000-0000-0000-000000000000', 'tesoreria'));
    ok(e5?.codigo === 'no_existe', 'un contrato que no existe se dice');

    console.log('\n 4. Rechazar y terminar');
    const e6 = await err(() => SQL.cancelarContrato(trx, T, com.id, 'tesoreria', 'no'));
    ok(e6?.codigo === 'invalido', 'rechazar sin motivo se niega');
    await SQL.cancelarContrato(trx, T, com.id, 'tesoreria', 'es la comisión del paquete: va con el contrato de la cuenta');
    const r3 = await SQL.proponerDesdeLaHistoria(trx, T, 'prueba-pgp210');
    ok(r3.contratos === 0, 'lo rechazado no se vuelve a proponer');
    const e9 = await err(() => SQL.confirmarContrato(trx, T, credito.id, 'tesoreria', { acreedor: 'Banco de prueba, crédito simple' }));
    ok(e9?.codigo === 'incompleto' && /Falta el PDF del contrato/.test(e9.message), 'DCR11: un crédito no se confirma sin el PDF del contrato');
    await SQL.confirmarContrato(trx, T, credito.id, 'tesoreria', { acreedor: 'Banco de prueba, crédito simple', documento: { storage_key: 'contratos/credito.pdf', nombre: 'credito.pdf' } });
    await SQL.terminarContrato(trx, T, credito.id, 'tesoreria', 'se liquidó el crédito', haceMeses(0, 1));
    const credT = (await trx.raw(`SELECT status, end_reason, to_char(ends_on, 'YYYY-MM-DD') AS fin, terminated_by FROM finance.charge_contracts WHERE id = ?`, [credito.id])).rows[0];
    ok(credT.status === 'terminado' && credT.end_reason === 'se liquidó el crédito' && credT.fin === haceMeses(0, 1) && credT.terminated_by === 'tesoreria', 'terminar deja motivo, fecha de fin y quién');

    console.log('\n 5. El alta a mano');
    const linea = await SQL.crearContrato(trx, T, 'tesoreria', {
      tipo: 'credito', acreedor: 'Línea de crédito de prueba', cuenta_id: cta.id, cadencia: 'mensual', dia_desde: 30, dia_hasta: 31,
      renglones: [
        { concepto: 'interes', descripcion: 'Interés de la disposición', regla_importe: 'estimado', tasa_referencia: 'TIIE28', tasa_puntos: 3.5, base_dias: 360 },
        { concepto: 'capital', descripcion: 'Capital', regla_importe: 'tabla', tabla: [{ fecha: haceMeses(-1, 6), importe: 50000, saldo: 150000 }, { fecha: haceMeses(-2, 6), importe: 50000, saldo: 100000 }, { fecha: haceMeses(-3, 6), importe: 50000, saldo: 50000 }] },
      ],
    });
    const lin = (await trx.raw(`SELECT c.status, c.origin, (SELECT count(*)::int FROM finance.charge_contract_schedule s JOIN finance.charge_contract_lines l ON l.id = s.line_id WHERE l.contract_id = c.id) AS filas,
        (SELECT rate_reference FROM finance.charge_contract_lines WHERE contract_id = c.id AND concept = 'interes') AS tasa FROM finance.charge_contracts c WHERE c.id = ?`, [linea])).rows[0];
    ok(lin.status === 'propuesto' && lin.origin === 'manual' && lin.filas === 3 && lin.tasa === 'TIIE28', 'nace propuesto, a mano, con el interés de tasa variable y la tabla de 3 pagos');
    await SQL.confirmarContrato(trx, T, linea, 'tesoreria', { documento: { storage_key: 'contratos/linea.pdf', nombre: 'linea.pdf' } });
    ok((await trx.raw(`SELECT status FROM finance.charge_contracts WHERE id = ?`, [linea])).rows[0].status === 'confirmado', 'y se confirma');
    const vacia = await SQL.crearContrato(trx, T, 'tesoreria', { tipo: 'credito', acreedor: 'Sin tabla', cuenta_id: cta.id, cadencia: 'mensual', dia_desde: 5, dia_hasta: 5,
      renglones: [{ concepto: 'capital', descripcion: 'Capital', regla_importe: 'tabla' }] });
    const e7 = await err(() => SQL.confirmarContrato(trx, T, vacia, 'tesoreria'));
    ok(e7?.codigo === 'incompleto' && /tabla está vacía/.test(e7.message), 'NEGATIVA: el capital por tabla con la tabla vacía no deja confirmar');
    const e8 = await err(() => SQL.crearContrato(trx, T, 'tesoreria', { tipo: 'servicio', acreedor: 'Sin renglones', cuenta_id: cta.id, cadencia: 'mensual', dia_desde: 1, dia_hasta: 1, renglones: [] }));
    ok(e8?.codigo === 'invalido', 'NEGATIVA: un contrato sin conceptos no se da de alta');

    console.log('\n 6. Cada CHECK rebota');
    const ins = (extra) => trx('finance.charge_contracts').insert({ tenant_id: T, creditor_name: 'Prueba', charge_bank_account_id: cta.id, day_from: 1, day_to: 1, origin: 'manual', created_by: 'prueba', ...extra });
    await rebota('k1', '23514', () => ins({ kind: 'prestamo' }), 'un tipo que no existe');
    await rebota('k2', '23514', () => ins({ status: 'aprobado' }), 'un estado que no existe');
    await rebota('k3', '23514', () => ins({ origin: 'importer' }), 'un origen que no existe');
    await rebota('k4', '23514', () => ins({ day_to: 32 }), 'el día 32 del mes');
    await rebota('k5', '23514', () => ins({ cadence: 'semanal', day_from: 5, day_to: 8 }), 'el día 8 de la semana');
    await rebota('k6', '23514', () => ins({ starts_on: '2026-06-01', ends_on: '2026-05-01' }), 'termina antes de empezar');
    await rebota('k7', '23514', () => ins({ creditor_name: ' ' }), 'sin acreedor');
    await rebota('k8', '23514', () => ins({ status: 'confirmado', confirmed_at: trx.fn.now(), confirmed_by: 'x' }), 'confirmado «por clasificar»');
    await rebota('k9', '23514', () => ins({ kind: 'servicio', status: 'confirmado', confirmed_at: trx.fn.now() }), 'confirmado sin quién');
    await rebota('k10', '23514', () => ins({ kind: 'servicio', status: 'terminado', confirmed_at: trx.fn.now(), confirmed_by: 'x', terminated_at: trx.fn.now(), terminated_by: 'x' }), 'terminado sin motivo');
    await rebota('k11', '23514', () => ins({ status: 'cancelado', cancelled_at: trx.fn.now(), cancelled_by: 'x', cancel_reason: 'no' }), 'rechazado con motivo de 2 letras');
    await rebota('k12', '23514', () => ins({ document_storage_key: 'x.pdf' }), 'el PDF sin su nombre');
    await rebota('k13', '23514', () => ins({ sucursal: 'Morelia' }), 'la sucursal que no es de dos dígitos');
    await rebota('k14', '23514', () => ins({ kind: 'arrendamiento', status: 'confirmado', confirmed_at: trx.fn.now(), confirmed_by: 'x' }), 'DCR11: arrendamiento confirmado sin PDF');
    const sinPdf = await sp('k15', async () => { await ins({ kind: 'cuota_comision', status: 'confirmado', confirmed_at: trx.fn.now(), confirmed_by: 'x' }); return true; }).catch(() => false);
    ok(sinPdf, 'DCR11: una cuota de comisión sí se confirma sin PDF (control de la negativa)');
    const lin1 = (extra) => trx('finance.charge_contract_lines').insert({ tenant_id: T, contract_id: domi.id, concept: 'renta', description: 'Renta', amount_rule: 'fijo', fixed_amount: 10, created_by: 'prueba', ...extra });
    await rebota('l1', '23514', () => lin1({ concept: 'multa' }), 'un concepto que no existe');
    await rebota('l2', '23514', () => lin1({ amount_rule: 'promedio' }), 'una regla de importe que no existe');
    await rebota('l3', '23514', () => lin1({ fixed_amount: null }), 'fijo sin importe');
    await rebota('l4', '23514', () => lin1({ amount_rule: 'estimado' }), 'estimado CON importe fijo');
    await rebota('l5', '23514', () => lin1({ fixed_amount: 0 }), 'importe en cero');
    await rebota('l6', '23514', () => lin1({ charges_per_period: 0 }), 'cero cargos por periodo');
    await rebota('l7', '23514', () => lin1({ rate_reference: 'TIIE28', day_count_basis: 360 }), 'tasa en un renglón que no es interés');
    await rebota('l8', '23514', () => lin1({ concept: 'interes', amount_rule: 'estimado', fixed_amount: null, rate_reference: 'TIIE28', day_count_basis: 300 }), 'base de días que no es 360 ni 365');
    const linId = (await trx.raw(`SELECT id::text FROM finance.charge_contract_lines WHERE contract_id = ? AND concept = 'capital'`, [linea])).rows[0].id;
    const fila = (extra) => trx('finance.charge_contract_schedule').insert({ tenant_id: T, line_id: linId, due_date: '2030-01-06', amount: 10, created_by: 'prueba', ...extra });
    await rebota('s1', '23514', () => fila({ amount: 0 }), 'una fila de la tabla en cero');
    await rebota('s2', '23514', () => fila({ principal_balance: -1 }), 'un saldo insoluto negativo');
    await rebota('s3', '23505', () => fila({ due_date: haceMeses(-1, 6) }), 'dos filas de la tabla el mismo día');

    console.log('\n 7. Como app_runtime');
    if (comoRuntime) {
      await rebota('p1', '42501', () => trx.raw(`DELETE FROM finance.charge_contracts WHERE id = ?`, [domi.id]), 'no borra un contrato (se termina o se rechaza)');
      await rebota('p2', '42501', () => trx.raw(`DELETE FROM finance.charge_contract_lines WHERE contract_id = ?`, [domi.id]), 'no borra un renglón');
      const borradas = await sp('p3', async () => (await trx.raw(`DELETE FROM finance.charge_contract_schedule WHERE line_id = ? RETURNING id`, [linId])).rows.length);
      ok(borradas === 3, `sí reemplaza la tabla de amortización (borró ${borradas} filas)`);
      await rebota('p4', '23503', () => sp('p4b', async () => {
        await trx.raw(`SET LOCAL app.tenant_id = '${OTRO}'`);
        await trx('finance.charge_contract_lines').insert({ tenant_id: OTRO, contract_id: domi.id, concept: 'renta', description: 'Cruzada', amount_rule: 'fijo', fixed_amount: 1, created_by: 'prueba' });
      }), 'un renglón de otro tenant no se cuelga de este contrato (llave compuesta)');
      await trx.raw(`SET LOCAL app.tenant_id = '${OTRO}'`);
      const ven = Number((await trx.raw(`SELECT count(*)::int AS n FROM finance.charge_contracts`)).rows[0].n);
      ok(ven === 0, `otro tenant no ve ningún contrato (RLS): ${ven}`);
      await rebota('p5', '42501', () => trx('finance.charge_contracts').insert({ tenant_id: T, creditor_name: 'Cruzado', charge_bank_account_id: cta.id, day_from: 1, day_to: 1, origin: 'manual', created_by: 'prueba' }),
        'otro tenant no escribe en el tenant ajeno (WITH CHECK)');
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    }
  } catch (e) {
    fail++; console.error('  ✗ ERROR:', e.message);
  } finally {
    await trx.rollback().catch(() => {});
  }
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
