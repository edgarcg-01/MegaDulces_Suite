/**
 * `[PQ.150]` LA FACTURA DEL SAT LIGADA A SU APLICACIÓN — `commercial.v_supplier_invoice_application`, con el SQL
 * de la PROPIA migración (se importa `cuerpo()`, no se copia: si alguien cambia la vista, esta prueba mide la nueva).
 *
 * Todo en transacciones de SÓLO LECTURA. Cuatro partes:
 *
 *   A. TS ≡ SQL — las réplicas en SQL de `folioNumero`, `nucleoReferencia`, `rfcComparable` y `rfcBienFormado`
 *      contra las funciones TypeScript que usa Recepción, en casos fijos (corre en cualquier Postgres) y, con el
 *      ODS, en los valores reales (folios de factura, referencias de aplicación, RFC de acreedores).
 *   B. CASOS ARMADOS — el mismo SQL con las tres fuentes cambiadas por `VALUES` (no se escribe una fila): las
 *      tres llaves, la cola del folio, el RFC con un glifo cambiado, la banda del total, ±$1, las ventanas, el
 *      uno a uno en los dos sentidos, CL005 y lo cancelado.
 *   C. ⭐ MUTANTES — cada guarda de la vista se rompe a propósito y los casos de B TIENEN que ponerse rojos.
 *   D. ⭐ CONTRA UN HECHO INDEPENDIENTE (prod, sólo lectura): el folio y el importe son llaves independientes;
 *      donde cada una sola encuentra factura, tienen que elegir la MISMA. Medido el 2026-11-25: 458 de 458.
 *      Y si la matvista ya existe, es la vista (misma cardinalidad). Sin el ODS (CI): NO MEDIDO, nunca verde.
 */
const path = require('path');
const fs = require('fs');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

// Las funciones TS de Recepción, tal cual. `receipt-match.ts` re-exporta de `@megadulces/contracts/...`: los
// alias se resuelven con los `paths` de tsconfig.base.json (leído con el parser de TypeScript: trae comentarios).
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
const GR = path.resolve(__dirname, '../../libs/finance/src/lib/goods-receipt-proofs');
const { folioNumero, rfcComparable, rfcBienFormado } = require(path.join(GR, 'receipt-match.ts'));
const { nucleoReferencia } = require(path.join(GR, 'emparejar-papel.ts'));
const MIG = require('../migrations-newdb/20261125090951_pq150_factura_ligada_a_su_aplicacion.js');

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
  return fn(trx);
});

// ─── A. TS ≡ SQL ──────────────────────────────────────────────────────────────────────────────
const TS = {
  FOLIO_NUMERO: (v) => folioNumero(v),
  NUCLEO: (v) => nucleoReferencia(v),
  RFC_COMPARABLE: (v) => rfcComparable(v),
  RFC_KEPLER: (v) => (rfcBienFormado(v) ? rfcComparable(v) : null),
};
const FIJOS = {
  FOLIO_NUMERO: ['666', 'F 97340', 'XA2001-0000140', 'No. 0006668', 'Folio 353', '00', '7', 'A3017', 'FMS124512', ' 0042 ', 'UD41-0099', '', 'ABC'],
  NUCLEO: ['30-0666', '0-F-2734', '10-4616', 'F-30036', '40 S/N', 'LPA', '50-47B0', ' 30 - 0666', '30-07', '', '0-F6778', 'RQ-2026-02'],
  RFC_COMPARABLE: ['AAA010101AAA', 'aaa-010101-aaa', 'BOB010101AB1', 'P&G851014AAA', 'ÑAÑ010101AAA', '', ' x '],
  RFC_KEPLER: ['AAA010101AAA', 'AAA 010101 AAA', 'AAA01O101AAA', 'XAXX010101000', 'P&G851014AAA', '12345', '', 'ABCD010101AB1'],
};
async function tsIgualSql(trx, nombre, valores) {
  const sql = MIG.SQL[nombre]('v.x');
  const { rows } = await trx.raw(`SELECT v.i, ${sql} AS r FROM unnest(?::text[]) WITH ORDINALITY AS v(x, i)`, [valores]);
  const malos = [];
  for (const r of rows) {
    const x = valores[Number(r.i) - 1];
    const t = TS[nombre](x) ?? null;
    if ((r.r ?? null) !== t) malos.push(`«${x}» TS=${t} SQL=${r.r}`);
  }
  return malos;
}

// ─── B. Los casos armados ─────────────────────────────────────────────────────────────────────
const T = '00000000-0000-0000-0000-00000000d01c';
const KDXD = [   // [sucursal, clave, nombre, RFC]
  ['08', 'PA', 'PROV A', 'AAA010101AAA'], ['08', 'PB', 'PROV B', ''], ['08', 'PC', 'PROV C', 'CCC010101CCC'],
  ['08', 'PD', 'PROV D', 'DDD010101DDD'], ['08', 'PE', 'PROV E', 'EEE010101EOE'], ['08', 'PF', 'PROV F', 'FFF010101FFF'],
  ['08', 'PG', 'PROV G', ''], ['08', 'CL005', 'CL', 'LLL010101LLL'], ['08', 'PH', 'PROV H', 'HHH010101HHH'],
  ['08', 'PJ', 'PROV J', 'JJJ010101JJJ'], ['08', 'PK', 'PROV K', ''],
];
const AP = [];   // [folio, prov, fecha, total, referencia, c43]
const CF = [];   // [id, rfc, folio, fecha, total, estatus]
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ID = {};
const cfdi = (clave, rfc, folio, fecha, total, estatus = 'Vigente') => { const id = uuid(); ID[clave] = id; CF.push([id, rfc, folio, fecha, total, estatus]); };
// A1 rfc_folio con la aplicación 4 % abajo (el caso de PQ.157) · A2 la referencia es la COLA del folio.
AP.push(['A1', 'PA', '2026-03-10', 960, '30-0666', '']); cfdi('A1', 'AAA010101AAA', '666', '2026-03-08', 1000);
AP.push(['A2', 'PA', '2026-03-20', 500, '10-4616', '']); cfdi('A2', 'AAA010101AAA', '3384616', '2026-03-19', 500);
// B1 folio_total: el acreedor sin RFC en Kepler · B2 NEGATIVA: el mismo, pero el total difiere $5.
AP.push(['B1', 'PB', '2026-03-10', 2734.4, '0-F-2734', '']); cfdi('B1', 'BBB010101BBB', 'F2734', '2026-03-09', 2734.9);
AP.push(['B2', 'PB', '2026-04-10', 900, '0-F-2800', '']); cfdi('B2', 'BBB010101BBB', '2800', '2026-04-09', 905);
// C1 rfc_total: la referencia no trae folio · C2 NEGATIVA: 21 días.
AP.push(['C1', 'PC', '2026-03-10', 1500, 'LPA', '']); cfdi('C1', 'CCC010101CCC', 'X1', '2026-03-05', 1500.5);
AP.push(['C2', 'PC', '2026-05-10', 1700, 'LPA', '']); cfdi('C2', 'CCC010101CCC', 'X2', '2026-04-19', 1700);
// D1 NEGATIVA de la banda: RFC + folio, pero la factura es de $6.48 (medido en prod) y el total no cuadra.
AP.push(['D1', 'PD', '2026-03-10', 6383.32, 'F-9093', '']); cfdi('D1', 'DDD010101DDD', '9093', '2026-03-08', 6.48);
// E1 el RFC con un glifo cambiado en Kepler (EOE ↔ E0E) se liga igual (rfcComparable pliega O→0).
AP.push(['E1', 'PE', '2026-03-10', 800, 'S/R', '']); cfdi('E1', 'EEE010101E0E', 'Z1', '2026-03-10', 800);
// F1/F2 NEGATIVA: dos facturas con el mismo folio para una aplicación (ambigua) y totales que no cuadran.
AP.push(['F1', 'PF', '2026-03-10', 300, '30-0777', '']); cfdi('F1a', 'FFF010101FFF', '777', '2026-03-01', 310); cfdi('F1b', 'FFF010101FFF', '777', '2026-03-05', 320);
// G1/G2 NEGATIVA: una factura que casa con DOS aplicaciones por folio + total.
AP.push(['G1', 'PG', '2026-03-10', 450, '0-F-5555', ''], ['G2', 'PG', '2026-03-11', 450, '0-F-5555', '']); cfdi('G', 'GGG010101GGG', '5555', '2026-03-09', 450);
// H: CL005 se trata aparte · H2 aplicación cancelada · H3 CFDI cancelado.
AP.push(['H1', 'CL005', '2026-03-10', 100, '30-0101', '']); cfdi('H1', 'LLL010101LLL', '101', '2026-03-09', 100);
AP.push(['H2', 'PH', '2026-03-10', 200, '30-0202', 'C']); cfdi('H2', 'HHH010101HHH', '202', '2026-03-09', 200);
AP.push(['H3', 'PH', '2026-04-10', 250, '30-0303', '']); cfdi('H3', 'HHH010101HHH', '303', '2026-04-09', 250, 'Cancelado');
// H4 NEGATIVA: una factura de CL005 no se pega a la aplicación de OTRO acreedor sin RFC por folio + total.
AP.push(['H4', 'PK', '2026-07-10', 120, '0-F-1201', '']); cfdi('H4', 'LLL010101LLL', '1201', '2026-07-09', 120);
// J1 la factura 61 días antes NO se liga por folio (la ventana es −60..+15) y su total no cuadra.
AP.push(['J1', 'PJ', '2026-05-10', 1000, '30-0404', '']); cfdi('J1', 'JJJ010101JJJ', '404', '2026-03-10', 1100);
// J2/J3: el folio liga J2; la misma factura NO se vuelve a usar por importe para J3 (otro folio, mismo total).
AP.push(['J2', 'PJ', '2026-06-10', 700, '30-0505', ''], ['J3', 'PJ', '2026-06-11', 700, 'SIN', '']); cfdi('J2', 'JJJ010101JJJ', '505', '2026-06-09', 700);

function conCasos(cuerpoSql) {
  const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const kdxd = KDXD.map(([s, c2, c3, c10]) => `(${lit(s)}, ${lit(c2)}, ${lit(c3)}, ${lit(c10)})`).join(',\n    ');
  const kdm1 = AP.map(([f, p, fe, t, ref, c43]) =>
    `('08', '08', 'X', 'A', 20::numeric, 1::numeric, ${lit(f)}, ${lit(fe)}::timestamp, ${lit(p)}, ${lit(ref)}, ${t}::numeric, ${lit(c43)})`).join(',\n    ');
  const cfdis = CF.map(([id, rfc, fol, fe, t, est]) =>
    `('${T}'::uuid, '${id}'::uuid, ${lit(id)}::varchar, ${lit(rfc)}::varchar, ${lit(fol)}::varchar, 'recibidas', 'I'::varchar, ${t}::numeric, (${lit(fe)}::date + time '12:00')::timestamp AT TIME ZONE 'America/Mexico_City', ${lit(est)})`).join(',\n    ');
  const fuentes = `
f_kdxd(sucursal, c2, c3, c10) AS (VALUES
    ${kdxd}),
f_kdm1(sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c11, c16, c43) AS (VALUES
    ${kdm1}),
f_cfdis(tenant_id, id, uuid, emisor_rfc, folio, rol, tipo_comprobante, total, fecha, estatus_sat) AS (VALUES
    ${cfdis}),`;
  let sql = cuerpoSql.replace(/kepler_ods\.kdxd/g, 'f_kdxd').replace(/kepler_ods\.kdm1/g, 'f_kdm1').replace(/fiscal\.cfdis/g, 'f_cfdis');
  if (/kepler_ods\.|fiscal\./.test(sql)) throw new Error('quedó una fuente real en el SQL de los casos');
  if (sql.includes('?')) throw new Error('el cuerpo trae «?»: chocaría con los parámetros de knex');
  return sql.replace(/^\s*WITH /, `WITH ${fuentes}\n`);
}

function juzgar(filas) {
  const de = (folio) => filas.filter((r) => r.folio === folio);
  const una = (folio, metodo, clave) => { const f = de(folio); return f.length === 1 && f[0].metodo === metodo && f[0].cfdi_id === ID[clave]; };
  const usadas = filas.map((r) => r.cfdi_id);
  return [
    ['rfc_folio: RFC + folio de la referencia (30-0666 ↔ 666) aunque la aplicación esté 4 % abajo', una('A1', 'rfc_folio', 'A1')],
    ['rfc_folio: la referencia es la COLA del folio (10-4616 ↔ 3384616)', una('A2', 'rfc_folio', 'A2')],
    ['folio_total: el acreedor SIN RFC en Kepler se liga por folio + total ±$1', una('B1', 'folio_total', 'B1')],
    ['NEGATIVA: folio igual pero el total difiere $5, sin RFC → sin liga', de('B2').length === 0],
    ['rfc_total: la referencia sin folio se liga por RFC + total ±$1', una('C1', 'rfc_total', 'C1')],
    ['NEGATIVA: RFC + total a 21 días → sin liga (±20)', de('C2').length === 0],
    ['NEGATIVA de la banda: la factura de $6.48 con el mismo folio NO es la de $6,383', de('D1').length === 0],
    ['el RFC con un glifo cambiado en Kepler (EOE ↔ E0E) se liga (rfcComparable)', una('E1', 'rfc_total', 'E1')],
    ['NEGATIVA: dos facturas con el mismo folio para una aplicación → no se elige', de('F1').length === 0],
    ['NEGATIVA: una factura que casa con dos aplicaciones → ninguna', de('G1').length === 0 && de('G2').length === 0 && !usadas.includes(ID.G)],
    ['NEGATIVA: CL005 se trata aparte', de('H1').length === 0],
    ['NEGATIVA: la factura de CL005 no se pega a la aplicación de otro acreedor por folio + total', de('H4').length === 0],
    ['NEGATIVA: la aplicación cancelada no se liga', de('H2').length === 0],
    ['NEGATIVA: el CFDI cancelado no se liga', de('H3').length === 0],
    ['NEGATIVA: la factura 61 días antes no se liga por folio', de('J1').length === 0],
    ['la factura ligada por folio (J2) no se vuelve a usar por importe para otra aplicación (J3)', una('J2', 'rfc_folio', 'J2') && de('J3').length === 0],
    ['uno a uno: ninguna factura aparece dos veces', new Set(usadas).size === usadas.length],
    ['nada más: exactamente A1, A2, B1, C1, E1 y J2', filas.length === 6],
  ];
}
const correrCasos = async (trx, cuerpoSql) => (await trx.raw(`SELECT * FROM (${conCasos(cuerpoSql)}) v ORDER BY folio`)).rows;

// ─── C. Los mutantes ──────────────────────────────────────────────────────────────────────────
const MUTANTES = [
  ['sin el «uno a uno»', 'WHERE n_ap = 1 AND n_cf = 1', 'WHERE true'],
  ['sin la banda del total en rfc_folio', 'AND cf.total > 0 AND ap.total BETWEEN cf.total * 0.5 AND cf.total * 2', ''],
  ['sin excluir CL005', 'WHERE NOT EXISTS (SELECT 1 FROM aparte a WHERE a.rfc = x.rfc)', ''],
  ['sin la cola del folio', 'OR (length(ap.nucleo) >= 4', 'OR (false AND length(ap.nucleo) >= 4'],
  ['sin plegar los glifos del RFC', "'OILSBZG', '0115826'", "'', ''"],
  ['sin excluir la factura ya usada por el folio', 'AND NOT EXISTS (SELECT 1 FROM p1 WHERE p1.cfdi_id = cf.id)\n     AND NOT EXISTS (SELECT 1 FROM p2', 'AND NOT EXISTS (SELECT 1 FROM p2'],
  ['sin la ventana de ±20 días', 'abs(cf.fecha - ap.fecha) <= 20', 'true'],
];

(async () => {
  console.log('\n[PQ.150] commercial.v_supplier_invoice_application — el SQL de la migración\n');

  console.log(' A. TS ≡ SQL (casos fijos)');
  try {
    await soloLectura(async (trx) => {
      for (const [nombre, vals] of Object.entries(FIJOS)) {
        const malos = await tsIgualSql(trx, nombre, vals);
        ok(malos.length === 0, `${nombre}: TS y SQL iguales en ${vals.length} casos${malos.length ? ` — ${malos.slice(0, 3).join(' · ')}` : ''}`);
      }
    });
  } catch (e) { noMedido(`no hay Postgres: ${e.message}`); return salir(); }

  console.log('\n B. Casos armados (VALUES, sólo lectura)');
  const base = await soloLectura((trx) => correrCasos(trx, MIG.cuerpo()));
  for (const [m, c] of juzgar(base)) ok(c, m);

  console.log('\n C. Mutantes: cada guarda rota TIENE que poner rojo algún caso');
  const texto = MIG.cuerpo();
  for (const [nombre, de, a] of MUTANTES) {
    if (!texto.includes(de)) { ok(false, `el mutante «${nombre}» no encontró su texto (¿cambió la vista?)`); continue; }
    const filas = await soloLectura((trx) => correrCasos(trx, texto.split(de).join(a)));
    const rojos = juzgar(filas).filter(([, c]) => !c).map(([m]) => m);
    ok(rojos.length > 0, `${nombre} → ${rojos.length ? `rojo (${rojos.length}): «${rojos[0].slice(0, 60)}…»` : 'SIGUE VERDE'}`);
  }

  console.log('\n D. Contra los datos reales (prod, sólo lectura)');
  const hayOds = await soloLectura(async (trx) => {
    const r = await trx.raw(`SELECT to_regclass('kepler_ods.kdm1') IS NOT NULL AS t`);
    if (!r.rows[0].t) return false;
    return (await trx.raw(`SELECT EXISTS (SELECT 1 FROM kepler_ods.kdm1 WHERE c2='X' AND c3='A' AND c4=20) AS e`)).rows[0].e;
  }).catch(() => false);
  if (!hayOds) { noMedido('esta base no tiene aplicaciones X-A-20 en el ODS (CI): TS≡SQL en valores reales y la concordancia se miden contra prod'); return salir(); }

  await soloLectura(async (trx) => {
    const reales = {
      FOLIO_NUMERO: (await trx.raw(`SELECT DISTINCT folio AS x FROM fiscal.cfdis WHERE rol='recibidas' AND folio IS NOT NULL AND fecha >= now() - interval '365 days' LIMIT 30000`)).rows,
      NUCLEO: (await trx.raw(`SELECT DISTINCT c11 AS x FROM kepler_ods.kdm1 WHERE c2='X' AND c3='A' AND c4=20 AND c11 IS NOT NULL LIMIT 30000`)).rows,
      RFC_COMPARABLE: (await trx.raw(`SELECT DISTINCT emisor_rfc AS x FROM fiscal.cfdis WHERE rol='recibidas' AND emisor_rfc IS NOT NULL LIMIT 30000`)).rows,
      RFC_KEPLER: (await trx.raw(`SELECT DISTINCT c10 AS x FROM kepler_ods.kdxd WHERE c10 IS NOT NULL LIMIT 30000`)).rows,
    };
    for (const [nombre, filas] of Object.entries(reales)) {
      const vals = filas.map((r) => String(r.x));
      const malos = await tsIgualSql(trx, nombre, vals);
      ok(malos.length === 0, `${nombre}: TS y SQL iguales en ${vals.length} valores reales${malos.length ? ` — ${malos.slice(0, 3).join(' · ')}` : ''}`);
    }

    // ⭐ El folio y el importe son llaves independientes: donde cada una SOLA da factura única, ¿la misma?
    // Se corre la vista con una sola llave a la vez (las otras dos apagadas en el texto) sobre 60 días.
    const solo = (metodo) => {
      let t = MIG.cuerpo().replace('AND btrim(m.c10) <> \'CL005\'', "AND btrim(m.c10) <> 'CL005' AND m.c9::date >= current_date - 63");
      if (metodo !== 'rfc_folio') t = t.replace('FROM ap JOIN cf ON cf.rfc = ap.rfc\n   WHERE ap.nucleo IS NOT NULL', 'FROM ap JOIN cf ON cf.rfc = ap.rfc\n   WHERE false AND ap.nucleo IS NOT NULL');
      if (metodo !== 'folio_total') t = t.replace('JOIN cf ON cf.tb = ap.tb + d.k\n   WHERE ap.nucleo IS NOT NULL', 'JOIN cf ON cf.tb = ap.tb + d.k\n   WHERE false AND ap.nucleo IS NOT NULL');
      if (metodo !== 'rfc_total') t = t.replace('JOIN cf ON cf.rfc = ap.rfc AND cf.tb = ap.tb + d.k\n   WHERE abs', 'JOIN cf ON cf.rfc = ap.rfc AND cf.tb = ap.tb + d.k\n   WHERE false AND abs');
      return t;
    };
    const lee = async (metodo) => new Map((await trx.raw(`SELECT sucursal||'|'||almacen||'|'||subtipo||'|'||folio AS k, cfdi_id::text AS id, metodo FROM (${solo(metodo)}) v`)).rows
      .map((r) => { if (r.metodo !== metodo) throw new Error(`el apagado de llaves falló: salió ${r.metodo} con sólo ${metodo}`); return [r.k, r.id]; }));
    const F = await lee('rfc_folio');
    const I = await lee('rfc_total');
    let ambas = 0, iguales = 0;
    for (const [k, id] of F) if (I.has(k)) { ambas++; if (I.get(k) === id) iguales++; }
    if (ambas < 200) noMedido(`sólo ${ambas} aplicaciones con las dos llaves en 60 días: muy pocas para afirmar la concordancia`);
    else ok(iguales / ambas >= 0.995, `CONTROL: folio y RFC + importe, cada uno solo, eligen la MISMA factura en ${iguales} de ${ambas} (piso 99.5 %; medido 458 de 458)`);

    const hayMv = (await trx.raw(`SELECT to_regclass(?) IS NOT NULL AS t`, [MIG.MV])).rows[0].t;
    if (!hayMv) { noMedido(`${MIG.MV} todavía no existe en esta base (migración sin aplicar)`); return; }
    const t0 = Date.now();
    const [{ v }] = (await trx.raw(`SELECT count(*)::int AS v FROM (${MIG.SELECT_SQL}) x`)).rows;
    const ms = Date.now() - t0;
    const [{ m, edad }] = (await trx.raw(`SELECT count(*)::int AS m, NULL::text AS edad FROM ${MIG.MV}`)).rows;
    void edad;
    ok(Math.abs(v - m) <= Math.max(20, v * 0.01), `la matvista es la vista: ${m} contra ${v} pares (tolerancia: lo que entró desde el último refresco) · vista ${ms} ms`);
  });
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
