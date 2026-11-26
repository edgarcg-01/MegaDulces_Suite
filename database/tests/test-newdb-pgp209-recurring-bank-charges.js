/**
 * `[PGP.209]` LOS CARGOS QUE EL BANCO COBRA SOLO — `finance.v_recurring_bank_charges`, con el SQL de la PROPIA
 * migración (se importa `SELECT_SQL`, no se copia: si alguien cambia la vista, esta prueba mide la nueva).
 *
 * Todo en transacciones de SÓLO LECTURA. Cuatro partes:
 *
 *   A. TS ≡ SQL — la comisión variable de terminal es de `[CB.62]`: la vista la deja fuera con `cargoDeTarjeta`
 *      (`comisiones-kepler.armador.ts`) llevada a SQL. En casos fijos (corre en cualquier Postgres) y, con los
 *      retiros de prod, renglón por renglón: las dos tienen que decir lo mismo.
 *   B. CASOS ARMADOS — el mismo SQL con las tres tablas cambiadas por `VALUES` y el día fijo (no se escribe una
 *      fila): el arrendamiento con el folio que cambia cada mes y la descarga que lo recorta, dos contratos del
 *      mismo importe, el crédito (capital fijo, interés que baja), los acentos, el día 31, lo que ya no cobra, y
 *      lo que NO es del banco (2 meses, la terminal, el traspaso, la Caja General, el libro, por transacción,
 *      lo borrado, lo de hace más de un año, el folio sin referencia estable).
 *   C. ⭐ MUTANTES — cada guarda de la vista se rompe a propósito y los casos de B TIENEN que ponerse rojos.
 *   D. ⭐ CONTRA HECHOS INDEPENDIENTES (prod, sólo lectura):
 *      · el RFC del acreedor que traen los estados subidos (la vista no lo lee): cada domiciliación que se repite
 *        al mismo importe tiene que estar propuesta;
 *      · el número del crédito: cada capital fijo y cada interés de 3 meses o más, propuestos;
 *      · las cuotas fijas del anexo §1.2, medidas con otra normalización del concepto;
 *      · PLACEBO: el importe + $37 no forma series;
 *      · la compuerta de la migración, verde con lo de prod y roja con un número roto (regla 12).
 *      Sin los retiros de prod (CI): NO MEDIDO, nunca verde.
 */
const path = require('path');
const fs = require('fs');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

// `cargoDeTarjeta` de CB.62, tal cual. El armador importa `@megadulces/contracts/...`: los alias se resuelven con
// los `paths` de tsconfig.base.json (leído con el parser de TypeScript: trae comentarios).
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
const { cargoDeTarjeta } = require(path.resolve(__dirname, '../../libs/finance/src/lib/bank/comisiones-kepler/comisiones-kepler.armador.ts'));
const MIG = require('../migrations-newdb/20261125224611_pgp209_cargos_recurrentes_del_banco.js');

const MEGA_DULCES = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const knex = require('knex')(require('../knexfile-newdb.js').development);
const salir = async () => {
  await knex.destroy();
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};
const soloLectura = (fn) => knex.transaction(async (trx) => {
  await trx.raw('SET TRANSACTION READ ONLY');
  await trx.raw('SET LOCAL statement_timeout = 180000');
  await trx.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES}'`);
  return fn(trx);
});
const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ─── A. TS ≡ SQL: la comisión de terminal de CB.62 ────────────────────────────────────────────
// Cada rama de las cuatro expresiones del armador, y lo que se le parece y NO es (números inventados).
const CONCEPTOS = [
  'APLI TASA DE DES CREDITO/171234567 TERMINALES PUNTO DE VENTA',
  'APLI TASA DE DES DEBITO/171234567 TERMINALES PUNTO DE VENTA',
  'IVA TASA DE DESC CREDITO/171234567 TERMINALES PUNTO DE VENTA',
  'IVA TASA DE DESC DEBITO/171234567 TERMINALES PUNTO DE VENTA',
  'COM VTAS TDC INTER/171234567 171234567', 'COM. VTA TDC INTER/171234567', 'IVA COM VTAS TDC INTER/171234567',
  'COM VTA NAL AMEX/171234567', 'COM. VTA. INTL. AMEX/171234567', 'IVA COM VTA NAL. AMEX/171234567',
  'COMISION 01234567CAPLICACION DE TASAS DE DESCUENTO DE CREDITO; FAMILIA:VENTA',
  'COMISION 01234567DAPLICACION DE TASAS DE DESCUENTO DE DEBITO',
  'IVA COMISION 01234567C', 'I.V.A. COMISION 01234567D CARGO', 'I V A COMISION 01234567C',
  '  apli  tasa de des  credito/171234567 terminales ',
  // NO son de terminal
  'APLI TASA DE DES CREDITO/1712 CORTO', 'COMISION 01234567XAPLICACION DE TASAS', 'IVA COMISION 01234567CX',
  'COMISION POR ADMINISTRACION', 'IVA COMISION ADMINISTRACION', 'DOMICILIACION PAGO SERVICIO', 'VENTAS CREDITO/141234567',
  'PAGO DE INTERESES 0123456789', '', null,
];
const tsEsTarjeta = (concepto, entra = 0, sale = 1) => cargoDeTarjeta({ concepto: concepto ?? '', entra, sale }) !== null;
const sqlTarjeta = (alias) => `(coalesce(${alias}.amount_in, 0) <= 0 AND upper(btrim(regexp_replace(coalesce(${alias}.concept, ''), '\\s+', ' ', 'g'))) ~ '${MIG.CARGO_DE_TARJETA}')`;

// ─── B. Los casos armados ─────────────────────────────────────────────────────────────────────
const HOY = '2026-11-25';
const T = MEGA_DULCES;
const CUENTAS = { A1: 'a1', A2: 'a2', CG: 'c9' };
const KIND = { A1: 'bank', A2: 'bank', CG: 'cash' };
const CATS = ['servicios', 'traspaso_entre_cuentas', 'comision_bancaria', 'iva_acreditable', 'pago_credito'];
const uuid = (pre, n) => `00000000-0000-0000-${pre.padStart(4, '0')}-${String(n).padStart(12, '0')}`;
const idCuenta = (k) => uuid(CUENTAS[k], 1);
const idCat = (code) => uuid('ca', CATS.indexOf(code) + 1);
const MOVS = [];
const CASO = new Map();   // id del movimiento → caso
let sec = 0;
function mov(caso, cuenta, fecha, importe, concepto, { cat = 'servicios', src = 'upload', borrado = false } = {}) {
  const id = uuid('b0', ++sec);
  CASO.set(id, caso);
  MOVS.push({ id, cuenta, fecha, importe, concepto, cat, src, borrado });
}
// F1 · arrendamiento: el folio cambia cada mes y la descarga (nov) recorta el concepto.
['2026-07-24', '2026-08-24', '2026-09-25', '2026-10-23'].forEach((f, i) =>
  mov('F1', 'A1', f, 21291, `DOMICILIACION PAGO SERVICIO '000${7101 + i} RFC AAA010101AA${i}`));
mov('F1', 'A1', '2026-11-24', 21291.00, 'DOMICILIACION PAGO SERVICIO', { src: 'banco' });
// F2 · dos contratos del mismo importe, el mismo mes.
for (const m of ['09', '10', '11']) { mov('F2', 'A1', `2026-${m}-24`, 11680, `DOMICILIACION PAGO SERVICIO '00${m}991 RFC AAA010101AAA`); mov('F2', 'A1', `2026-${m}-27`, 11680, 'DOMICILIACION PAGO SERVICIO', { src: 'banco' }); }
// F3 · sólo 2 meses.
mov('F3', 'A1', '2026-10-10', 9999, 'DOMICILIACION PAGO SERVICIO'); mov('F3', 'A1', '2026-11-10', 9999, 'DOMICILIACION PAGO SERVICIO');
// F4 · la comisión de terminal y su IVA, al mismo importe 3 meses (es de CB.62).
for (const m of ['09', '10', '11']) {
  mov('F4', 'A1', `2026-${m}-15`, 9.35, 'APLI TASA DE DES CREDITO/171234567 TERMINALES PUNTO DE VENTA', { cat: 'comision_bancaria' });
  mov('F4', 'A1', `2026-${m}-15`, 1.50, 'IVA TASA DE DESC CREDITO/171234567 TERMINALES PUNTO DE VENTA', { cat: 'iva_acreditable' });
}
// F5 · traspaso entre cuentas, el mismo importe 3 meses.
for (const m of ['09', '10', '11']) mov('F5', 'A1', `2026-${m}-10`, 50000, 'TRASPASO ENTRE CTAS', { cat: 'traspaso_entre_cuentas' });
// F6 · la Caja General no es banco.
for (const m of ['09', '10', '11']) mov('F6', 'CG', `2026-${m}-05`, 16607, 'RENTA BODEGA');
// F7 · el libro (sheet).
for (const m of ['09', '10', '11']) mov('F7', 'A2', `2026-${m}-08`, 5000, 'PAGO SEGURO AUTO', { src: 'sheet' });
// F8 · por transacción: 4 al mes.
for (const m of ['09', '10', '11']) for (const d of ['03', '09', '16', '22']) mov('F8', 'A2', `2026-${m}-${d}`, 5.80, 'COMISION SPEI ENVIADO', { cat: 'comision_bancaria' });
// F9 · el de noviembre está borrado: quedan 2 meses.
mov('F9', 'A2', '2026-09-12', 777, 'CUOTA ANUAL TARJETA'); mov('F9', 'A2', '2026-10-12', 777, 'CUOTA ANUAL TARJETA');
mov('F9', 'A2', '2026-11-12', 777, 'CUOTA ANUAL TARJETA', { borrado: true });
// F10 · acentos y minúsculas: la misma cabeza.
mov('F10', 'A2', '2026-09-02', 520, 'COMISIÓN ADMINISTRACIÓN RENTA', { cat: 'comision_bancaria' });
mov('F10', 'A2', '2026-10-02', 520, 'COMISION ADMINISTRACION RENTA', { cat: 'comision_bancaria', src: 'banco' });
mov('F10', 'A2', '2026-11-03', 520, 'Comisión administración renta', { cat: 'comision_bancaria', src: 'banco' });
// F11 · hace más de un año.
for (const f of ['2025-08-01', '2025-09-01', '2025-10-01']) mov('F11', 'A2', f, 4000, 'PAGO ANTIGUO SERVICIO');
// V1 · el crédito: capital fijo, interés que baja (mismo número de crédito).
const INT = [22013.10, 20486.20, 16076.30, 12693.40, 10529.50];
['2026-07-05', '2026-08-05', '2026-09-07', '2026-10-05', '2026-11-05'].forEach((f, i) => {
  mov('V1c', 'A2', f, 83333.33, 'PAGO DE CAPITAL 0123456789', { cat: 'pago_credito' });
  mov('V1i', 'A2', f, INT[i], 'PAGO DE INTERESES 0123456789', { cat: 'pago_credito' });
});
// V2 · el folio cambia y el importe también: no hay serie.
['09', '10', '11'].forEach((m, i) => mov('V2', 'A1', `2026-${m}-18`, 100.10 * (i + 1), `DOMICILIACION PAGO SERVICIO 00${m}201 RFC AAA010101AAA`));
// V3 · un seguro: 3 meses igual (ya no) y luego sube cada mes (mismo número): dos series, ningún movimiento en las dos.
['2026-06-20', '2026-07-20', '2026-08-20'].forEach((f) => mov('V3f', 'A2', f, 500, 'SEGURO CREDITO 0555555555'));
['2026-09-20', '2026-10-20', '2026-11-20'].forEach((f, i) => mov('V3v', 'A2', f, 520 + 10 * i, 'SEGURO CREDITO 0555555555'));
// VIG · ya no cobra: su último cargo, más de 40 días antes del último movimiento de su cuenta.
['2026-04-30', '2026-05-29', '2026-06-30', '2026-07-31'].forEach((f) => mov('VIG', 'A2', f, 1299, 'MEMBRESIA TRANSACCIONES ESPECIAL', { cat: 'comision_bancaria' }));
// D31 · cobra el último día: el próximo de noviembre es el 30.
['2026-08-31', '2026-09-30', '2026-10-31'].forEach((f) => mov('D31', 'A2', f, 1000, 'PAGO VIDA SEGURA MENSUAL'));

function conCasos(sql) {
  const movs = MOVS.map((m, i) => {
    const t = (v, ty) => `${v}${i ? '' : `::${ty}`}`;
    return `(${t(lit(m.id), 'uuid')}, ${t(lit(T), 'uuid')}, ${t(lit(idCuenta(m.cuenta)), 'uuid')}, ${t(lit(m.fecha), 'date')}, ` +
      `${t(m.importe, 'numeric')}, ${t(0, 'numeric')}, ${t(lit(m.concepto), 'text')}, ${t(lit(idCat(m.cat)), 'uuid')}, ${t(lit(m.src), 'text')}, ` +
      `${t(m.borrado ? "'2026-11-20'" : 'NULL', 'timestamptz')})`;
  }).join(',\n    ');
  const cuentas = Object.keys(CUENTAS).map((k, i) => `(${lit(idCuenta(k))}${i ? '' : '::uuid'}, ${lit(KIND[k])})`).join(', ');
  const cats = CATS.map((c, i) => `(${lit(idCat(c))}${i ? '' : '::uuid'}, ${lit(c)})`).join(', ');
  const fuentes = `
f_movs(id, tenant_id, bank_account_id, movement_date, amount_out, amount_in, concept, category_id, sync_source, deleted_at) AS (VALUES
    ${movs}),
f_cuentas(id, kind) AS (VALUES ${cuentas}),
f_cats(id, code) AS (VALUES ${cats}),`;
  const s = sql.replace(/finance\.bank_movements/g, 'f_movs').replace(/finance\.bank_accounts/g, 'f_cuentas')
    .replace(/finance\.movement_categories/g, 'f_cats').replace(/current_date/g, `DATE '${HOY}'`);
  if (/finance\./.test(s)) throw new Error('quedó una tabla real en el SQL de los casos');
  if (s.includes('?')) throw new Error('el cuerpo trae «?»: chocaría con los parámetros de knex');
  return s.replace(/^\s*WITH /, `WITH ${fuentes}\n`);
}
const correrCasos = async (trx, sql) => (await trx.raw(`
  SELECT v.*, v.movement_ids::text[] AS ids, v.next_expected_date::text AS prox, v.last_charge_date::text AS ult
    FROM (${conCasos(sql)}) v`)).rows;

function juzgar(filas) {
  const casosDe = (r) => [...new Set(r.ids.map((id) => CASO.get(id)))];
  const de = (caso) => filas.filter((r) => casosDe(r).includes(caso));
  const una = (caso) => { const f = de(caso); return f.length === 1 && casosDe(f[0]).length === 1 ? f[0] : null; };
  const n = (v) => (v == null ? null : Number(v));
  const cuenta = (caso) => [...CASO.values()].filter((c) => c === caso).length;
  const es = (caso, extra) => { const r = una(caso); return !!r && r.ids.length === cuenta(caso) && extra(r); };
  const ids = filas.flatMap((r) => r.ids);
  return [
    ['arrendamiento: el folio que cambia y la descarga que recorta son UNA serie fija de 5 meses, día 24, el próximo el 24-dic',
      es('F1', (r) => r.rule === 'fixed_amount' && r.months === 5 && n(r.fixed_amount) === 21291 && r.charges_per_month === 1 &&
        r.concept_head === 'DOMICILIACION PAGO SERVICIO' && r.typical_day === 24 && r.prox === '2026-12-24' && r.is_active === true)],
    ['dos contratos del mismo importe: 2 cargos al mes, se esperan $23,360', es('F2', (r) => r.charges_per_month === 2 && r.charges === 6 && n(r.expected_monthly_amount) === 23360)],
    ['NEGATIVA: 2 meses no son serie', de('F3').length === 0],
    ['NEGATIVA: la comisión de terminal y su IVA son de CB.62', de('F4').length === 0],
    ['NEGATIVA: el traspaso entre cuentas lo hace la empresa', de('F5').length === 0],
    ['NEGATIVA: la Caja General no es banco', de('F6').length === 0],
    ['NEGATIVA: el libro (sheet) no entra', de('F7').length === 0],
    ['NEGATIVA: 4 al mes es por transacción', de('F8').length === 0],
    ['NEGATIVA: lo borrado no cuenta (quedan 2 meses)', de('F9').length === 0],
    ['acentos y minúsculas: una cabeza («COMISION ADMINISTRACION RENTA»), 3 meses', es('F10', (r) => r.months === 3 && r.concept_head === 'COMISION ADMINISTRACION RENTA')],
    ['NEGATIVA: lo de hace más de un año no entra', de('F11').length === 0],
    ['el capital del crédito: fijo, 5 meses', es('V1c', (r) => r.rule === 'fixed_amount' && n(r.fixed_amount) === 83333.33 && r.months === 5)],
    ['el interés que baja: variable con su número de crédito, se espera el último ($10,529.50), el próximo el 5-dic',
      es('V1i', (r) => r.rule === 'variable_amount' && r.series_reference === '0123456789' && r.fixed_amount == null &&
        n(r.last_amount) === 10529.5 && n(r.expected_monthly_amount) === 10529.5 && n(r.min_amount) === 10529.5 && n(r.max_amount) === 22013.1 && r.prox === '2026-12-05')],
    ['NEGATIVA: el folio cambia y el importe también: no hay serie', de('V2').length === 0],
    ['el seguro igual 3 meses y luego variable: dos series', es('V3f', (r) => r.rule === 'fixed_amount' && r.is_active === false) && es('V3v', (r) => r.rule === 'variable_amount' && r.months === 3)],
    ['lo que ya no cobra se dice: no vigente', es('VIG', (r) => r.is_active === false && r.ult === '2026-07-31')],
    ['el día 31: el próximo de noviembre es el 30', es('D31', (r) => r.typical_day === 31 && r.prox === '2026-11-30')],
    ['ningún movimiento en dos series', ids.length === new Set(ids).size],
    ['nada más: exactamente 9 series', filas.length === 9],
    ['la llave de la serie es única', new Set(filas.map((r) => r.series_key)).size === filas.length],
  ];
}

// ─── C. Mutantes ──────────────────────────────────────────────────────────────────────────────
const MUTANTES = [
  ['sin la regla de 3 meses', `>= ${MIG.MESES_MINIMOS}`, '>= 1'],
  ['sin dejar fuera la comisión de terminal (CB.62)', `AND NOT (coalesce(m.amount_in, 0) <= 0 AND`, 'AND NOT (false AND'],
  ['sin las categorías de la empresa', `AND coalesce(c.code, '') NOT IN ('traspaso_entre_cuentas', 'compra_mercancia', 'compra_tarjeta', 'nomina')`, ''],
  ['sin pedir que sea banco', `AND ba.kind = 'bank'`, ''],
  ['con el libro sheet', `m.sync_source IN ('banco', 'upload')`, `m.sync_source IN ('banco', 'upload', 'sheet')`],
  ['sin el tope de cargos por mes', `<= ${MIG.MAX_CARGOS_POR_MES} * count(`, '<= 100 * count('],
  ['sin la baja lógica', 'WHERE m.deleted_at IS NULL\n     AND', 'WHERE'],
  ['sin quitar los acentos', `translate(upper(m.concept), 'ÁÉÍÓÚÜáéíóúüñ', 'AEIOUUAEIOUUÑ')`, 'upper(m.concept)'],
  ['la vigencia sin límite', `- ${MIG.VIGENCIA_DIAS} AS is_active`, '- 400 AS is_active'],
  ['sin el tope del mes corto', 'least(s.dia_tipico,', 'greatest(s.dia_tipico,'],
  ['la ventana de dos años', 'current_date - 365', 'current_date - 730'],
  ['lo fijo también en la serie variable', `   WHERE NOT EXISTS (SELECT 1 FROM fijo f WHERE f.tenant_id = b.tenant_id AND f.bank_account_id = b.bank_account_id
                       AND f.cabeza = b.cabeza AND f.importe = b.importe)
),
serie AS`, `),
serie AS`],
];

(async () => {
  console.log('\n[PGP.209] finance.v_recurring_bank_charges — el SQL de la migración\n');

  console.log(' A. TS ≡ SQL: la comisión de terminal de CB.62');
  let sqlFijos;
  try {
    sqlFijos = await soloLectura(async (trx) => (await trx.raw(`
      SELECT x.i, ${sqlTarjeta('x')} AS es FROM (VALUES ${CONCEPTOS.map((c, i) => `(${i}, ${lit(c)}::text, 0::numeric)`).join(', ')}) x(i, concept, amount_in)`)).rows);
  } catch (e) { noMedido(`no hay Postgres: ${e.message}`); return salir(); }
  const malosFijos = CONCEPTOS.filter((c, i) => tsEsTarjeta(c) !== sqlFijos.find((r) => r.i === i).es);
  const deTerminal = CONCEPTOS.filter((c) => tsEsTarjeta(c)).length;
  ok(malosFijos.length === 0 && deTerminal === 16,
    `casos fijos: el armador y el SQL dicen lo mismo en ${CONCEPTOS.length - malosFijos.length} de ${CONCEPTOS.length} (${deTerminal} de terminal, se esperan 16)${malosFijos.length ? ` — difieren: ${malosFijos.slice(0, 3).join(' · ')}` : ''}`);
  ok(!tsEsTarjeta(CONCEPTOS[0], 5, 1), 'el armador no toma un renglón con entrada (el SQL pide amount_in <= 0)');

  console.log('\n B. Casos armados (VALUES, sólo lectura)');
  const base = await soloLectura((trx) => correrCasos(trx, MIG.SELECT_SQL));
  for (const [m, c] of juzgar(base)) ok(c, m);

  console.log('\n C. Mutantes: cada guarda rota TIENE que poner rojo algún caso');
  for (const [nombre, de, a] of MUTANTES) {
    if (!MIG.SELECT_SQL.includes(de)) { ok(false, `el mutante «${nombre}» no encontró su texto (¿cambió la vista?)`); continue; }
    let rojos;
    try {
      const filas = await soloLectura((trx) => correrCasos(trx, MIG.SELECT_SQL.split(de).join(a)));
      rojos = juzgar(filas).filter(([, c]) => !c).map(([m]) => m);
    } catch (e) { rojos = [`el SQL mutado no corre: ${e.message.slice(0, 60)}`]; }
    ok(rojos.length > 0, `${nombre} → ${rojos.length ? `rojo (${rojos.length}): «${rojos[0].slice(0, 60)}…»` : 'SIGUE VERDE'}`);
  }

  console.log('\n D. Contra los datos reales (prod, sólo lectura)');
  const retiros = await soloLectura(async (trx) => {
    if (!(await trx.raw(`SELECT to_regclass('finance.bank_movements') IS NOT NULL AS t`)).rows[0].t) return 0;
    return (await trx.raw(`SELECT count(*)::int AS n FROM finance.bank_movements
      WHERE deleted_at IS NULL AND amount_out > 0 AND sync_source IN ('banco', 'upload') AND movement_date >= current_date - 365`)).rows[0].n;
  }).catch(() => 0);
  if (retiros < MIG.RETIROS_DE_PROD) { noMedido(`esta base tiene ${retiros} retiros de banco (CI): los controles se miden contra prod`); return salir(); }

  await soloLectura(async (trx) => {
    // A con los retiros reales: renglón por renglón.
    const R = (await trx.raw(`
      SELECT m.id::text, m.bank_account_id::text AS cuenta, m.movement_date::text AS fecha, m.amount_out::float AS sale,
             coalesce(m.amount_in, 0)::float AS entra, m.concept, c.code AS cat, ba.kind, m.sync_source AS src, ${sqlTarjeta('m')} AS tarjeta_sql
        FROM finance.bank_movements m JOIN finance.bank_accounts ba ON ba.id = m.bank_account_id
        LEFT JOIN finance.movement_categories c ON c.id = m.category_id
       WHERE m.deleted_at IS NULL AND m.amount_out > 0 AND m.movement_date >= current_date - 365`)).rows;
    let tarjeta = 0; const difieren = [];
    for (const r of R) {
      const ts = tsEsTarjeta(r.concept, r.entra, r.sale);
      if (ts) tarjeta++;
      if (ts !== r.tarjeta_sql && difieren.length < 3) difieren.push(`${r.fecha} «${String(r.concept).slice(0, 40)}» TS ${ts} SQL ${r.tarjeta_sql}`);
    }
    ok(difieren.length === 0 && tarjeta > 1000,
      `TS ≡ SQL en los retiros reales: el armador de CB.62 y la vista dicen lo mismo en ${R.length} retiros (${tarjeta} de terminal)${difieren.length ? ` — ${difieren.join(' · ')}` : ''}`);

    const t0 = Date.now();
    const V = (await trx.raw(`SELECT v.*, v.movement_ids::text[] AS ids, v.bank_account_id::text AS cuenta FROM (${MIG.SELECT_SQL}) v`)).rows;
    const ms = Date.now() - t0;
    ok(ms < 10000, `costo: la vista entera en ${(ms / 1000).toFixed(1)} s (techo 10 s)`);
    const enSerie = new Map();
    for (const s of V) for (const id of s.ids) enSerie.set(id, [...(enSerie.get(id) || []), s]);
    const act = V.filter((s) => s.is_active);
    const alMes = act.reduce((a, s) => a + Number(s.expected_monthly_amount), 0);
    const fijas = act.filter((s) => s.rule === 'fixed_amount');
    const variables = act.filter((s) => s.rule === 'variable_amount');
    const repetidos = [...enSerie.values()].filter((xs) => xs.length > 1).length;
    console.log(`    → ${V.length} series en 12 meses; ${act.length} vigentes (${fijas.length} fijas, ${variables.length} variables) en ` +
      `${new Set(act.map((s) => s.cuenta)).size} cuentas, $${Math.round(alMes).toLocaleString('en-US')} al mes`);
    ok(repetidos === 0 && new Set(V.map((s) => s.series_key)).size === V.length, `ningún movimiento en dos series y la llave es única (${V.length} series)`);

    // La compuerta de la migración, con SU SQL (la vista todavía no existe en prod: va como subconsulta) y con un
    // número roto.
    const sqlCompuerta = MIG.SQL_COMPUERTA.replace(`${MIG.VISTA} v2`, `(${MIG.SELECT_SQL}) v2`).split(MIG.VISTA).join(`(${MIG.SELECT_SQL}) vv`);
    const medido = (await trx.raw(sqlCompuerta)).rows[0];
    const err = MIG.juzgarCompuerta(medido);
    ok(err === null && medido.vigentes === act.length && medido.repetidos === repetidos,
      `la compuerta de la migración, con su SQL, pasa con lo de prod (${medido.vigentes} vigentes, $${Math.round(Number(medido.al_mes)).toLocaleString('en-US')} al mes)${err ? `: ${err}` : ''}`);
    ok(MIG.juzgarCompuerta({ ...medido, vigentes: 5 }) !== null && MIG.juzgarCompuerta({ ...medido, repetidos: 1 }) !== null &&
      MIG.juzgarCompuerta({ ...medido, variables_vigentes: 0 }) !== null && MIG.juzgarCompuerta({ ...medido, al_mes: 1000 }) !== null,
      'NEGATIVA: la compuerta se pone roja con 5 series, un movimiento repetido, sin variables o con $1,000 al mes');

    // Lo que la vista conserva (su universo), para los controles.
    const CATS_EMPRESA = new Set(['traspaso_entre_cuentas', 'compra_mercancia', 'compra_tarjeta', 'nomina']);
    const U = R.filter((r) => r.kind === 'bank' && ['banco', 'upload'].includes(r.src) && !CATS_EMPRESA.has(r.cat) && !tsEsTarjeta(r.concept, r.entra, r.sale));
    const mes = (f) => f.slice(0, 7);
    const cubierto = (rows, regla) => rows.every((r) => (enSerie.get(r.id) || []).some((s) => !regla || s.rule === regla));

    // D1. El RFC del acreedor (sólo lo traen los estados subidos; la vista no lo lee).
    const RFC = /RFC\s*([A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3})/;
    const porRfc = new Map();
    for (const r of U) {
      const m = /DOMICILIA/i.test(r.concept || '') && RFC.exec(String(r.concept).toUpperCase());
      if (!m) continue;
      const k = `${r.cuenta}|${m[1]}|${r.sale.toFixed(2)}`;
      porRfc.set(k, [...(porRfc.get(k) || []), r]);
    }
    const E = [...porRfc.entries()].filter(([, rows]) => new Set(rows.map((r) => mes(r.fecha))).size >= 3);
    const sinCubrir = E.filter(([, rows]) => !cubierto(rows, 'fixed_amount'));
    const acreedores = new Set(E.map(([k]) => k.split('|')[1]));
    ok(E.length >= 10 && sinCubrir.length === 0,
      `CONTROL por el RFC del acreedor (la vista no lo lee): ${E.length - sinCubrir.length} de ${E.length} domiciliaciones de importe fijo y 3 meses o más, propuestas (${acreedores.size} acreedores)` +
      `${sinCubrir.length ? ` — faltan ${sinCubrir.length}: ${sinCubrir.slice(0, 2).map(([k, rows]) => `$${k.split('|')[2]} en ${rows.length} cargos`).join(' · ')}` : ''}`);

    // D2. El número del crédito: capital fijo e interés.
    const credito = (re, filtro) => {
      const g = new Map();
      for (const r of U) { const m = re.exec(String(r.concept || '').toUpperCase()); if (m) g.set(`${r.cuenta}|${m[1]}`, [...(g.get(`${r.cuenta}|${m[1]}`) || []), r]); }
      return [...g.entries()].filter(([, rows]) => new Set(rows.map((r) => mes(r.fecha))).size >= 3 && filtro(rows));
    };
    const capitales = credito(/^PAGO DE CAPITAL\s+(\d{6,})/, (rows) => new Set(rows.map((r) => r.sale.toFixed(2))).size === 1);
    const intereses = credito(/^PAGO DE INTERESES\s+(\d{6,})/, () => true);
    ok(capitales.length >= 2 && capitales.every(([, rows]) => cubierto(rows, 'fixed_amount')),
      `CONTROL por el número del crédito: ${capitales.filter(([, rows]) => cubierto(rows, 'fixed_amount')).length} de ${capitales.length} capitales fijos propuestos como fijos`);
    ok(intereses.length >= 2 && intereses.every(([k, rows]) => cubierto(rows) && rows.every((r) => enSerie.get(r.id)?.[0]?.series_reference === k.split('|')[1])),
      `CONTROL: ${intereses.length} intereses de crédito, cada uno UNA serie con su número de crédito`);

    // D3. Las cuotas fijas del anexo §1.2, con otra normalización del concepto (28 letras, dígitos fuera).
    const COMISION = /COMISION|CUOTA|MEMBRESIA|ANUALIDAD|PENAL|SERV BANCA|ADMINISTRACION PAQUETE|COM SERV/i;
    const norm = (c) => String(c || '').toUpperCase().replace(/[0-9/|:.-]+/g, '#').slice(0, 28);
    const g12 = new Map();
    for (const r of U.filter((x) => x.fecha >= '2026-06-01' && (['comision_bancaria', 'iva_acreditable'].includes(x.cat) || COMISION.test(x.concept || '')))) {
      const k = `${r.cuenta}|${norm(r.concept)}|${r.sale.toFixed(2)}`;
      g12.set(k, [...(g12.get(k) || []), r]);
    }
    const S = [...g12.values()].filter((rows) => {
      const meses = new Set(rows.map((r) => mes(r.fecha))).size;
      return meses >= 3 && rows.length <= MIG.MAX_CARGOS_POR_MES * meses;
    });
    const movsS = S.flat();
    const enV = movsS.filter((r) => enSerie.has(r.id)).length;
    const pctS = movsS.length ? enV / movsS.length : 0;
    ok(S.length >= 20 && pctS >= 0.9,
      `CONTROL de las cuotas fijas (§1.2, otra normalización): ${enV} de ${movsS.length} cargos (${(pctS * 100).toFixed(1)} %; piso 90 %) de ${S.length} series, propuestos`);

    // D4. PLACEBO: el importe + $37 en la misma cuenta no forma series.
    const porImporte = new Map();
    for (const r of U) { const k = `${r.cuenta}|${r.sale.toFixed(2)}`; porImporte.set(k, [...(porImporte.get(k) || []), r]); }
    const placebo = fijas.filter((s) => {
      const rows = porImporte.get(`${s.cuenta}|${(Number(s.fixed_amount) + 37).toFixed(2)}`) || [];
      return new Set(rows.map((r) => mes(r.fecha))).size >= 3;
    });
    ok(fijas.length >= 20 && placebo.length === 0, `PLACEBO: con el importe + $37, ${placebo.length} de ${fijas.length} series fijas vigentes se repiten 3 meses`);
  });
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
