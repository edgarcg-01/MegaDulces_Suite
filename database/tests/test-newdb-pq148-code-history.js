/**
 * `[PQ.148]` LO QUE LA HISTORIA ENSEÑA DEL CATÁLOGO DEL PROVEEDOR — `commercial.v_supplier_item_code_history`,
 * con el SQL de la PROPIA migración (se importa `cuerpo()`, no se copia: si alguien cambia la vista,
 * esta prueba mide la nueva).
 *
 * Todo en transacciones de SÓLO LECTURA. Tres partes:
 *
 *   A. CASOS ARMADOS — el mismo SQL con las cuatro fuentes cambiadas por `VALUES` (no se escribe una
 *      fila en ningún lado; corre en cualquier Postgres, también en el del CI): BOM al inicio del XML,
 *      `&amp;` des-escapado, código normalizado, descuento, factor, ±$1, ±20 días en el borde, un
 *      par ambiguo en cada sentido, CL005, aplicación cancelada, CFDI cancelado, código corto,
 *      código repetido en la factura, renglones empatados, y el código que cambió de producto.
 *   B. ⭐ MUTANTES — cada guarda de la vista se rompe a propósito en el texto del SQL y los casos de A
 *      TIENEN que ponerse rojos. Si una guarda se puede quitar sin que nada falle, la prueba no la
 *      estaba midiendo (un gate sin prueba negativa es una intención).
 *   C. ⭐ CONTRA UN HECHO INDEPENDIENTE (prod, sólo lectura): se aprende de lo anterior a hace 30 días
 *      y se compara lo que la historia propone contra el SKU que la persona registró en la aplicación
 *      de Kepler en los últimos 30 días; el placebo es la propuesta del renglón vecino de la misma
 *      factura. Sin el ODS (CI) se declara NO MEDIDO, nunca verde. Medido el 2026-11-24: 1,054 de
 *      1,058 (99.6 %) contra 0 de 1,025.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const MIG = require('../migrations-newdb/20261124231441_pq148_v_supplier_item_code_history.js');

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
  await trx.raw('SET LOCAL statement_timeout = 120000');
  return fn(trx);
});

// ─── A. Los casos armados ─────────────────────────────────────────────────────────────────────
const T = '00000000-0000-0000-0000-00000000d01c';
const BOM = String.fromCharCode(0xfeff);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const xml = (conceptos, { bom = true } = {}) => (bom ? BOM : '')
  + '<?xml version="1.0" encoding="UTF-8"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0"><cfdi:Conceptos>'
  + conceptos.map((c) => `<cfdi:Concepto NoIdentificacion="${esc(c.cod)}" Descripcion="${esc(c.desc || 'PRODUCTO')}" Cantidad="${c.q || 1}"`
    + ` ClaveUnidad="${c.u || 'H87'}" Importe="${c.imp}"${c.dto ? ` Descuento="${c.dto}"` : ''}/>`).join('')
  + '</cfdi:Conceptos></cfdi:Comprobante>';

// Proveedores: (sucursal, clave de acreedor, RFC). D es CL005 (se trata aparte).
const KDXD = [
  ['08', 'PA', 'AAA010101AAA'], ['08', 'PB', 'BBB010101BBB'], ['08', 'PC', 'CCC010101CCC'],
  ['08', 'CL005', 'DDD010101DDD'], ['08', 'PE', 'EEE010101EEE'], ['08', 'PF', 'FFF010101FFF'], ['08', 'PH', 'HHH010101HHH'],
];
const ap = [];   // [folio, prov, fecha, total, c43, renglones: [sku, cantidad, importe]]
const cf = [];   // [id, rfc, fecha, total, estatus, xml]
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const caso = (prov, rfc, { fecha, total, fechaAp = fecha, totalAp = total, c43 = '', estatus = 'Vigente', bom = true, conceptos, renglones, folio }) => {
  cf.push([uuid(), rfc, fecha, total, estatus, xml(conceptos, { bom })]);
  ap.push([folio, prov, fechaAp, totalAp, c43, renglones]);
};
// A: el caso bueno, en cinco facturas.
caso('PA', 'AAA010101AAA', { folio: 'A1', fecha: '2026-01-10', total: 1000, fechaAp: '2026-01-12', totalAp: 1000.4,
  conceptos: [{ cod: 'ab-01 ', desc: 'P&G CREMA', q: 2, imp: 600 }, { cod: ' ab  02', q: 4, imp: 400 }],
  renglones: [['S1', 24, 600], ['S2', 4, 400]] });
caso('PA', 'AAA010101AAA', { folio: 'A2', fecha: '2026-02-10', total: 900, bom: false,
  conceptos: [{ cod: 'AB-01', desc: 'P&G CREMA', q: 1, imp: 300 }, { cod: 'AB-03', imp: 200 }, { cod: 'AB-03', imp: 250 }, { cod: '7', imp: 150 }],
  renglones: [['S1', 12, 300], ['S3', 1, 200], ['S4', 1, 250], ['S5', 1, 150]] });
caso('PA', 'AAA010101AAA', { folio: 'A3', fecha: '2026-03-10', total: 500,
  conceptos: [{ cod: 'AB 02', imp: 500 }], renglones: [['S9', 1, 500]] });
caso('PA', 'AAA010101AAA', { folio: 'A4', fecha: '2026-04-10', total: 700,
  conceptos: [{ cod: 'AB-05', imp: 800, dto: 100 }], renglones: [['S6', 1, 700]] });
caso('PA', 'AAA010101AAA', { folio: 'A5', fecha: '2026-05-10', total: 200,
  conceptos: [{ cod: 'AB-07', imp: 100 }, { cod: 'AB-08', imp: 100 }], renglones: [['S7', 1, 100], ['S8', 1, 100]] });
// B: ambiguo en los dos sentidos — una factura con dos aplicaciones, y dos facturas con una aplicación.
cf.push([uuid(), 'BBB010101BBB', '2026-01-10', 500, 'Vigente', xml([{ cod: 'BB-01', imp: 500 }])]);
ap.push(['B1', 'PB', '2026-01-11', 500, '', [['SB1', 1, 500]]], ['B2', 'PB', '2026-01-15', 500, '', [['SB1', 1, 500]]]);
cf.push([uuid(), 'BBB010101BBB', '2026-06-01', 300, 'Vigente', xml([{ cod: 'BB-02', imp: 300 }])]);
cf.push([uuid(), 'BBB010101BBB', '2026-06-03', 300, 'Vigente', xml([{ cod: 'BB-02', imp: 300 }])]);
ap.push(['B3', 'PB', '2026-06-02', 300, '', [['SB2', 1, 300]]]);
// C: la ventana de ±20 días — 24 días no, 20 justos sí.
caso('PC', 'CCC010101CCC', { folio: 'C1', fecha: '2026-01-01', fechaAp: '2026-01-25', total: 100, conceptos: [{ cod: 'CC-00', imp: 100 }], renglones: [['SC0', 1, 100]] });
caso('PC', 'CCC010101CCC', { folio: 'C2', fecha: '2026-03-01', fechaAp: '2026-03-21', total: 100, conceptos: [{ cod: 'CC-01', imp: 100 }], renglones: [['SC1', 1, 100]] });
// D: CL005 se trata aparte · E: aplicación cancelada · F: CFDI cancelado · H: el total difiere $1.50.
caso('CL005', 'DDD010101DDD', { folio: 'D1', fecha: '2026-01-10', total: 100, conceptos: [{ cod: 'DD-01', imp: 100 }], renglones: [['SD1', 1, 100]] });
caso('PE', 'EEE010101EEE', { folio: 'E1', fecha: '2026-01-10', total: 100, c43: 'C', conceptos: [{ cod: 'EE-01', imp: 100 }], renglones: [['SE1', 1, 100]] });
caso('PF', 'FFF010101FFF', { folio: 'F1', fecha: '2026-01-10', total: 100, estatus: 'Cancelado', conceptos: [{ cod: 'FF-01', imp: 100 }], renglones: [['SF1', 1, 100]] });
caso('PH', 'HHH010101HHH', { folio: 'H1', fecha: '2026-01-10', total: 1000, totalAp: 1001.5, conceptos: [{ cod: 'HH-01', imp: 1000 }], renglones: [['SH1', 1, 1000]] });

/** El SQL de la vista con las cuatro fuentes cambiadas por los casos (VALUES tipados como las tablas). */
function conCasos(cuerpoSql) {
  if (cuerpoSql.includes('?')) throw new Error('el cuerpo de la vista trae «?»: chocaría con los parámetros de knex');
  const bind = [];
  const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const kdxd = KDXD.map(([s, c2, c10]) => `(${lit(s)}, ${lit(c2)}, ${lit(c10)})`).join(',\n    ');
  const kdm1 = ap.map(([f, p, fe, t, c43]) => `('08', '08', 'X', 'A', 20::numeric, 1::numeric, ${lit(f)}, ${lit(fe)}::timestamp, ${lit(p)}, ${t}::numeric, ${lit(c43)})`).join(',\n    ');
  const kdm2 = ap.flatMap(([f, , , , , rs]) => rs.map(([sku, q, imp], i) =>
    `('08', '08', 'X', 'A', 20::numeric, 1::numeric, ${lit(f)}, ${i + 1}::numeric, ${lit(sku)}, ${q}::float8, ${lit('NOMBRE ' + sku)}, 'PZA', ${imp}::numeric)`)).join(',\n    ');
  const cfdis = cf.map(([id, rfc, fe, t, est, x]) => { bind.push(x);
    return `('${T}'::uuid, '${id}'::uuid, ${lit(rfc)}::varchar, 'recibidas', 'I'::varchar, ${t}::numeric, (${lit(fe)}::date + time '12:00')::timestamp AT TIME ZONE 'America/Mexico_City', ?::text, ${lit(est)})`; }).join(',\n    ');
  const fuentes = `
f_kdxd(sucursal, c2, c10) AS (VALUES
    ${kdxd}),
f_kdm1(sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c43) AS (VALUES
    ${kdm1}),
f_kdm2(sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c13) AS (VALUES
    ${kdm2}),
f_cfdis(tenant_id, id, emisor_rfc, rol, tipo_comprobante, total, fecha, xml, estatus_sat) AS (VALUES
    ${cfdis}),`;
  let sql = cuerpoSql
    .replace(/kepler_ods\.kdxd/g, 'f_kdxd').replace(/kepler_ods\.kdm1/g, 'f_kdm1')
    .replace(/kepler_ods\.kdm2/g, 'f_kdm2').replace(/fiscal\.cfdis/g, 'f_cfdis');
  if (/kepler_ods\.|fiscal\./.test(sql)) throw new Error('quedó una fuente real en el SQL de los casos');
  sql = sql.replace(/^\s*WITH /, `WITH ${fuentes}\n`);
  return { sql, bind };
}

/** Lo que los casos TIENEN que dar. Devuelve [nombre, cumple] para poder correrlo también con mutantes. */
function juzgar(filas) {
  const de = (rfc, cod) => filas.find((r) => r.proveedor_rfc === rfc && r.codigo_proveedor === cod);
  const a01 = de('AAA010101AAA', 'AB-01');
  const a02 = de('AAA010101AAA', 'AB 02');
  const a05 = de('AAA010101AAA', 'AB-05');
  const rfcs = new Set(filas.map((r) => r.proveedor_rfc));
  return [
    ['AB-01 → S1 en 2 facturas, estable, factor 12 (el proveedor factura cajas, Kepler registra piezas)',
      !!a01 && a01.sku === 'S1' && a01.facturas === 2 && a01.estable === true && Number(a01.factor_kepler) === 12 && a01.factores_distintos === 1],
    ['la factura que empieza con BOM se lee (sin ella AB-01 tendría 1 factura)', !!a01 && a01.facturas === 2],
    ['la descripción sale des-escapada («P&G», no «P&amp;G»)', !!a01 && a01.descripcion_proveedor === 'P&G CREMA'],
    ['el código se normaliza como normCodigo (« ab  02» y «AB 02» son el mismo)', !!a02 && a02.facturas === 2],
    ['NEGATIVA: el código que cambió de producto NO es estable (va a revisión)', !!a02 && a02.estable === false && a02.skus_distintos === 2 && a02.sku === 'S9'],
    ['el descuento se resta del importe (800 − 100 = 700 casa con su renglón)', !!a05 && a05.sku === 'S6'],
    ['NEGATIVA: un código repetido en la misma factura no se aprende', !de('AAA010101AAA', 'AB-03')],
    ['NEGATIVA: un código de 1–2 caracteres no se aprende', !filas.some((r) => r.codigo_proveedor === '7')],
    ['NEGATIVA: dos renglones con el mismo importe no enseñan nada', !de('AAA010101AAA', 'AB-07') && !de('AAA010101AAA', 'AB-08')],
    ['NEGATIVA: una factura con dos aplicaciones, o dos facturas con una, no se emparejan', !rfcs.has('BBB010101BBB')],
    ['la ventana es ±20 días: 20 justos sí (CC-01), 24 no (CC-00)', !!de('CCC010101CCC', 'CC-01') && !de('CCC010101CCC', 'CC-00')],
    ['NEGATIVA: CL005 se trata aparte', !rfcs.has('DDD010101DDD')],
    ['NEGATIVA: la aplicación cancelada en Kepler no enseña', !rfcs.has('EEE010101EEE')],
    ['NEGATIVA: el CFDI cancelado en el SAT no enseña', !rfcs.has('FFF010101FFF')],
    ['NEGATIVA: un total que difiere $1.50 no se empareja (±$1)', !rfcs.has('HHH010101HHH')],
    ['nada más: A da exactamente AB-01, AB 02 y AB-05', filas.filter((r) => r.proveedor_rfc === 'AAA010101AAA').length === 3],
  ];
}

const correrCasos = async (trx, cuerpoSql) => {
  const { sql, bind } = conCasos(cuerpoSql);
  return (await trx.raw(`SELECT * FROM (${sql}) v ORDER BY proveedor_rfc, codigo_proveedor`, bind)).rows;
};

// ─── B. Los mutantes: cada guarda, rota a propósito ────────────────────────────────────────────
const MUTANTES = [
  ['sin el «uno a uno» factura ↔ aplicación', 'WHERE n_cfdi = 1 AND n_ap = 1', 'WHERE true'],
  ['sin recortar el BOM', 'ltrim(c.xml, chr(65279))', 'c.xml'],
  ['sin des-escapar los atributos', "'&amp;', '&')", "'&amp;', '&amp;')"],
  ['sin excluir CL005', 'AND NOT EXISTS (SELECT 1 FROM aparte a WHERE a.rfc = p.rfc)', ''],
  ['sin la guarda de 3+ caracteres', 'CASE WHEN length(cod) >= 3 THEN cod END', 'cod'],
  ['sin la guarda del código repetido', 'AND codigo IS NOT NULL AND rep_en_factura = 1', 'AND codigo IS NOT NULL'],
];

(async () => {
  console.log('\n[PQ.148] commercial.v_supplier_item_code_history — el SQL de la migración\n');

  console.log(' A. Casos armados (VALUES, sólo lectura)');
  let base;
  try { base = await soloLectura((trx) => correrCasos(trx, MIG.cuerpo())); } catch (e) { noMedido(`no hay Postgres para los casos: ${e.message}`); return salir(); }
  for (const [m, c] of juzgar(base)) ok(c, m);

  console.log('\n B. Mutantes: cada guarda rota TIENE que poner rojo algún caso');
  const texto = MIG.cuerpo();
  for (const [nombre, de, a] of MUTANTES) {
    if (!texto.includes(de)) { ok(false, `el mutante «${nombre}» no encontró su texto (¿cambió la vista?)`); continue; }
    const filas = await soloLectura((trx) => correrCasos(trx, texto.split(de).join(a)));
    const rojos = juzgar(filas).filter(([, c]) => !c).map(([m]) => m);
    ok(rojos.length > 0, `${nombre} → ${rojos.length ? `rojo (${rojos.length}): «${rojos[0].slice(0, 60)}…»` : 'SIGUE VERDE'}`);
  }

  console.log('\n C. Contra un hecho independiente (prod, sólo lectura)');
  const hayOds = await soloLectura(async (trx) => {
    const r = await trx.raw(`SELECT to_regclass('kepler_ods.kdm1') IS NOT NULL AS t`);
    if (!r.rows[0].t) return false;
    return (await trx.raw(`SELECT EXISTS (SELECT 1 FROM kepler_ods.kdm1 WHERE c2='X' AND c3='A' AND c4=20) AS e`)).rows[0].e;
  }).catch(() => false);
  if (!hayOds) { noMedido('esta base no tiene aplicaciones X-A-20 en el ODS (CI): la precisión se mide contra prod'); return salir(); }

  await soloLectura(async (trx) => {
    const hoy = (await trx.raw(`SELECT ((now() AT TIME ZONE 'America/Mexico_City')::date - 30)::text AS d`)).rows[0].d;
    const t0 = Date.now();
    const todo = (await trx.raw(`SELECT * FROM (${MIG.SELECT_SQL}) v`)).rows;
    console.log(`    (vista entera: ${todo.length} equivalencias, ${todo.filter((r) => r.estable).length} estables, ${Date.now() - t0} ms)`);
    const aprendido = new Map((await trx.raw(`SELECT * FROM (${MIG.cuerpo(hoy)}) v`)).rows.map((r) => [`${r.proveedor_rfc}|${r.codigo_proveedor}`, r]));
    const prueba = (await trx.raw(`SELECT * FROM (${MIG.cuerpo(null, { renglones: true })}) u WHERE fecha >= ?::date`, [hoy])).rows;
    const porFactura = new Map();
    for (const r of prueba) { if (!porFactura.has(r.cfdi_id)) porFactura.set(r.cfdi_id, []); porFactura.get(r.cfdi_id).push(r); }
    let prop = 0, acierta = 0, plac = 0, placOk = 0;
    for (const [, rs] of porFactura) {
      rs.sort((a, b) => Number(a.ord) - Number(b.ord));
      rs.forEach((r, i) => {
        const a = aprendido.get(`${r.rfc}|${r.codigo}`);
        if (a && a.estable) { prop++; if (a.sku === r.sku) acierta++; }
        if (rs.length > 1) {
          const v = rs[(i + 1) % rs.length];
          const b = aprendido.get(`${v.rfc}|${v.codigo}`);
          if (b && b.estable) { plac++; if (b.sku === r.sku) placOk++; }
        }
      });
    }
    if (prop < 200) { noMedido(`sólo ${prop} renglones con propuesta en 30 días: muy pocos para afirmar la precisión`); return; }
    const p = acierta / prop, q = plac ? placOk / plac : 0;
    ok(p >= 0.95, `CONTROL: lo que la historia propone es el SKU que Kepler registró en ${acierta} de ${prop} renglones que no vio (${(100 * p).toFixed(1)} %, piso 95 %)`);
    ok(q <= 0.10, `PLACEBO: la propuesta del renglón vecino acierta ${placOk} de ${plac} (${(100 * q).toFixed(1)} %, techo 10 %)`);

    // El filtro por proveedor (lo que hace el servicio) da EXACTAMENTE la parte de la vista entera.
    const porProv = new Map(); for (const r of todo) porProv.set(r.proveedor_rfc, (porProv.get(r.proveedor_rfc) || 0) + 1);
    for (const [rfc, cuantos] of [...porProv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      const t1 = Date.now();
      const f = (await trx.raw(`SELECT * FROM (${MIG.SELECT_SQL}) v WHERE proveedor_rfc = ?`, [rfc])).rows;
      const ms = Date.now() - t1;
      ok(f.length === cuantos && ms < 10000, `filtrar por un proveedor da sus ${cuantos} equivalencias, igual que la vista entera (${ms} ms, techo 10 s)`);
    }
  });
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
