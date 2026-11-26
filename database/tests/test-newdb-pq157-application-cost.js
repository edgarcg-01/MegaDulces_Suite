/**
 * `[PQ.157]` EL COSTO DE LA APLICACIÓN CONTRA EL DE SU OC — `commercial.v_application_line_cost`, con el SQL de la
 * PROPIA migración (se importa `SELECT_SQL`, no se copia: si alguien cambia la vista, esta prueba mide la nueva).
 *
 * Todo en transacciones de SÓLO LECTURA. Tres partes:
 *
 *   A. CASOS ARMADOS — el mismo SQL con `kdm1`, `kdm2` y `kdii` cambiadas por `VALUES` (no se escribe una fila):
 *      la cadena aplicación → orden de entrada → vale → OC, el corte de «igual» (0.5 % y 1 centavo), la escala con
 *      los factores de la ficha (los dos sentidos, `c84/c81`, sin factor, ambiguo, sin ficha), el vale sin OC, el
 *      precio en cero, la OC de la Suite, y lo que no entra (cancelada, CL005, otro almacén).
 *   B. ⭐ MUTANTES — cada guarda de la vista se rompe a propósito y los casos de A TIENEN que ponerse rojos.
 *   C. ⭐ CONTRA UN HECHO INDEPENDIENTE (prod, sólo lectura):
 *      · CONTROL: una versión en JS que encadena los documentos y clasifica por su cuenta (lee `kdm2` y `kdii`
 *        sin la vista) tiene que dar el MISMO estado en cada renglón de 60 días. Medido el 2026-11-25: 11,908 de 11,908.
 *      · TESTIGO de la escala: en los renglones escalados, la CANTIDAD también cambió por el factor elegido (la
 *        cantidad no se usa para elegirlo). Medido: 87 %; placebo con el doble del factor: ≈ 0.
 *      Sin el ODS (CI): NO MEDIDO, nunca verde.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const MIG = require('../migrations-newdb/20261125214023_pq157_costo_de_la_aplicacion_contra_la_oc.js');

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

// ─── A. Los casos armados ─────────────────────────────────────────────────────────────────────
// Cada caso es una cadena completa: OC (35) ← vale (37) ← orden de entrada (40) ← aplicación (20), un renglón.
const KDM1 = [];   // [sucursal, c1, c4, c5, c6, c9, c10, c43, c67]
const KDM2 = [];   // [sucursal, c1, c4, c5, c6, c7, c8, c9, c11, c12, c13, c20, c21, c22, c23]
const KDII = [];   // [sucursal, c1, c81, c84]
const FECHA = '2026-11-01';
// `conOC: false` = el vale dice «sin origen» (`c20 = 0`) PERO sus `c21..c23` apuntan a una OC que existe: un
// residuo así no puede encadenarse (la guarda `v.c20 = 35` tiene que ser observable).
function cadena(id, { p_oc, p_ap, q = 10, sku = `S${id}`, prov = 'PA', conOC = true, suite = false, c43 = '', almacen = '08' }) {
  const f = (t) => `${t}${id}`;
  KDM1.push(['08', '08', 35, 1, f('OC'), FECHA, prov, '', suite ? 'SUITE' : 'K01']);
  KDM2.push(['08', '08', 35, 1, f('OC'), 1, sku, q, 'CJA', conOC ? p_oc : 99, q * (conOC ? p_oc : 99), 30, 1, 'RQ', 1]);
  KDM1.push(['08', '08', 37, 1, f('VA'), FECHA, prov, '', 'K01']);
  KDM2.push(['08', '08', 37, 1, f('VA'), 1, sku, q, 'CJA', conOC ? p_oc : p_ap, q * p_ap, conOC ? 35 : 0, 1, f('OC'), 1]);
  KDM1.push(['08', '08', 40, 1, f('OE'), FECHA, prov, '', 'K01']);
  KDM2.push(['08', '08', 40, 1, f('OE'), 1, sku, q, 'CJA', p_ap, q * p_ap, 37, 1, f('VA'), 1]);
  KDM1.push(['08', almacen, 20, 1, f('AP'), FECHA, prov, c43, 'K02']);
  KDM2.push(['08', almacen, 20, 1, f('AP'), 1, sku, q, 'CJA', p_ap, q * p_ap, 40, 1, f('OE'), 1]);
}
// Misma escala
cadena('N1', { p_oc: 100, p_ap: 100 });                       // igual exacto
cadena('N2', { p_oc: 0.5, p_ap: 0.505 });                     // 1 % pero medio centavo → igual
cadena('N3', { p_oc: 100, p_ap: 100.4 });                     // 0.4 % → igual
cadena('N4', { p_oc: 100, p_ap: 104, q: 10 });                // sube 4 %, +$40
cadena('N5', { p_oc: 50, p_ap: 47, q: 2 });                   // baja 6 %, −$6
// Escala con la ficha
KDII.push(['08', 'SS1', 24, null], ['08', 'SS2', 24, null], ['08', 'SS3', 24, null], ['08', 'SS4', 6, null],
  ['08', 'SS5', 12, 24], ['08', 'SS6', 6, 24]);
cadena('S1', { sku: 'SS1', p_oc: 240, p_ap: 10, q: 48 });     // OC en caja de 24, aplicación por pieza: igual
cadena('S2', { sku: 'SS2', p_oc: 240, p_ap: 10.5, q: 24 });   // la pieza sube 5 % → +$12 (24 × 0.50)
cadena('S3', { sku: 'SS3', p_oc: 10, p_ap: 250, q: 2 });      // la aplicación en la unidad mayor: 250 contra 240 → sube
cadena('S4', { sku: 'SS4', p_oc: 240, p_ap: 10 });            // cociente 24 y la ficha sólo tiene 6 → sin factor
cadena('S5', { sku: 'SS5', p_oc: 170, p_ap: 10 });            // cociente 17: 12 y 24 casi igual de cerca → ambigua
cadena('S6', { sku: 'SS6', p_oc: 40, p_ap: 10 });             // cociente 4 = c84/c81 (24/6) → igual con factor 4
cadena('S7', { sku: 'SIN_FICHA', p_oc: 240, p_ap: 10 });      // sin ficha en la sucursal → sin factor, pero el renglón está
// Otros estados
cadena('V1', { p_oc: null, p_ap: 30, conOC: false });         // vale sin OC (con residuo que apunta a una)
cadena('P1', { p_oc: 0, p_ap: 30 });                          // la OC con precio cero
cadena('O1', { p_oc: 80, p_ap: 80, suite: true });            // OC escrita por la Suite
// Lo que NO entra
cadena('X1', { p_oc: 100, p_ap: 120, c43: 'C' });             // aplicación cancelada
cadena('X2', { p_oc: 100, p_ap: 120, prov: 'CL005' });        // CEDIS: aparte
cadena('X3', { p_oc: 100, p_ap: 120, almacen: '99' });        // almacén que no es la sucursal

function conCasos(sql) {
  const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const num = (v) => (v == null ? 'NULL' : String(v));
  const kdm1 = KDM1.map(([s, c1, c4, c5, c6, c9, c10, c43, c67], i) =>
    `(${lit(s)}, ${lit(c1)}, 'X', 'A', ${c4}${i ? '' : '::numeric'}, ${c5}${i ? '' : '::numeric'}, ${lit(c6)}, ${lit(c9)}::timestamp, ${lit(c10)}, ${lit(c43)}, ${lit(c67)})`).join(',\n    ');
  const kdm2 = KDM2.map(([s, c1, c4, c5, c6, c7, c8, c9, c11, c12, c13, c20, c21, c22, c23], i) => {
    const t = (v, ty) => `${num(v)}${i ? '' : `::${ty}`}`;
    return `(${lit(s)}, ${lit(c1)}, 'X', 'A', ${t(c4, 'numeric')}, ${t(c5, 'numeric')}, ${lit(c6)}, ${t(c7, 'numeric')}, ${lit(c8)}, ${t(c9, 'float8')}, ${lit(c11)}, ` +
      `${t(c12, 'numeric')}, ${t(c13, 'numeric')}, ${t(c20, 'numeric')}, ${t(c21, 'numeric')}, ${lit(c22)}, ${t(c23, 'numeric')})`;
  }).join(',\n    ');
  const kdii = KDII.map(([s, c1, c81, c84], i) => `(${lit(s)}, ${lit(c1)}, ${num(c81)}${i ? '' : '::numeric'}, ${num(c84)}${i ? '' : '::numeric'})`).join(',\n    ');
  const fuentes = `
f_kdm1(sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c43, c67) AS (VALUES
    ${kdm1}),
f_kdm2(sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c11, c12, c13, c20, c21, c22, c23) AS (VALUES
    ${kdm2}),
f_kdii(sucursal, c1, c81, c84) AS (VALUES
    ${kdii}),`;
  const s = sql.replace(/kepler_ods\.kdm1/g, 'f_kdm1').replace(/kepler_ods\.kdm2/g, 'f_kdm2').replace(/kepler_ods\.kdii/g, 'f_kdii');
  if (/kepler_ods\./.test(s)) throw new Error('quedó una fuente real en el SQL de los casos');
  if (s.includes('?')) throw new Error('el cuerpo trae «?»: chocaría con los parámetros de knex');
  return s.replace(/^\s*WITH /, `WITH ${fuentes}\n`);
}

function juzgar(filas) {
  const de = (id) => filas.filter((r) => r.folio === `AP${id}`);
  const una = (id) => { const f = de(id); return f.length === 1 ? f[0] : null; };
  const es = (id, estado, extra = () => true) => { const r = una(id); return !!r && r.estado_costo === estado && extra(r); };
  const n = (v) => (v == null ? null : Number(v));
  return [
    ['igual exacto: variación 0 y sin pesos', es('N1', 'igual', (r) => n(r.variacion_pct) === 0 && r.pesos_vs_oc == null && r.escala === 'misma')],
    ['igual a medio centavo aunque sea 1 % (precio de 50 centavos)', es('N2', 'igual')],
    ['igual al 0.4 %', es('N3', 'igual')],
    ['sube 4 %: +$40 en 10 piezas', es('N4', 'sube', (r) => n(r.variacion_pct) === 4 && n(r.pesos_vs_oc) === 40)],
    ['baja 6 %: −$6 en 2 piezas', es('N5', 'baja', (r) => n(r.variacion_pct) === -6 && n(r.pesos_vs_oc) === -6)],
    ['escala: OC en caja de 24, aplicación por pieza → igual, factor 24, precio de la OC por pieza 10', es('S1', 'igual', (r) => r.escala === 'oc_en_unidad_mayor' && n(r.factor_escala) === 24 && n(r.precio_oc_equivalente) === 10)],
    ['escala: la pieza sube 5 % → +$12 (24 piezas × 50 centavos)', es('S2', 'sube', (r) => n(r.variacion_pct) === 5 && n(r.pesos_vs_oc) === 12)],
    ['escala al revés: la aplicación en la unidad mayor (250 contra 24 × 10 = 240) → sube', es('S3', 'sube', (r) => r.escala === 'aplicacion_en_unidad_mayor' && n(r.precio_oc_equivalente) === 240)],
    ['NEGATIVA: ningún factor de la ficha casa → otra_escala_sin_factor, sin veredicto', es('S4', 'otra_escala_sin_factor', (r) => r.variacion_pct == null && r.pesos_vs_oc == null)],
    ['NEGATIVA: dos factores casi igual de cerca → otra_escala_ambigua, sin veredicto', es('S5', 'otra_escala_ambigua', (r) => r.variacion_pct == null)],
    ['el factor c84/c81 (24/6 = 4) también es un peldaño', es('S6', 'igual', (r) => n(r.factor_escala) === 4)],
    ['sin ficha en la sucursal: el renglón sigue en la vista, sin factor', es('S7', 'otra_escala_sin_factor')],
    ['vale sin OC → sin_oc, sin precio de la OC', es('V1', 'sin_oc', (r) => r.precio_oc == null && r.oc_folio == null)],
    ['la OC con precio cero → sin_precio', es('P1', 'sin_precio')],
    ['la OC escrita por la Suite se dice; las demás no', !!una('O1')?.oc_de_la_suite && una('N1')?.oc_de_la_suite === false],
    ['la cadena completa: OC, vale y orden de entrada del renglón', es('N4', 'sube', (r) => r.oc_folio === 'OCN4' && r.vale_folio === 'VAN4' && r.oe_folio === 'OEN4' && n(r.precio_orden_entrada) === 104)],
    ['NEGATIVA: la aplicación cancelada no entra', de('X1').length === 0],
    ['NEGATIVA: CL005 se trata aparte', de('X2').length === 0],
    ['NEGATIVA: el almacén que no es la sucursal no entra', de('X3').length === 0],
    ['nada más: exactamente 15 renglones, uno por caso', filas.length === 15],
  ];
}
const correrCasos = async (trx, sql) => (await trx.raw(`SELECT * FROM (${conCasos(sql)}) v ORDER BY folio`)).rows;

// ─── B. Los mutantes ──────────────────────────────────────────────────────────────────────────
const MUTANTES = [
  ['sin la regla del centavo', `abs(s.precio_aplicacion - p.peq) <= ${MIG.CENTAVO} OR `, ''],
  ['«igual» sólo si es exacto', `<= ${MIG.TOL} THEN 'igual'`, `<= 0 THEN 'igual'`],
  ['sin los factores de la ficha', 'ARRAY[e.f2, e.f3, e.f3 / NULLIF(e.f2, 0)]', 'ARRAY[NULL::numeric]'],
  ['sin el peldaño c84/c81', 'ARRAY[e.f2, e.f3, e.f3 / NULLIF(e.f2, 0)]', 'ARRAY[e.f2, e.f3]'],
  ['sin la guarda de ambigüedad', 'OR (d2 IS NOT NULL AND d2 < 2 * d1 AND d1 > 0.005)', ''],
  ['la escala al revés', 'WHEN s.oc_mayor THEN s.precio_oc / s.factor ELSE s.precio_oc * s.factor', 'WHEN s.oc_mayor THEN s.precio_oc * s.factor ELSE s.precio_oc / s.factor'],
  ['sin excluir CL005', "AND btrim(h.c10) <> 'CL005'", ''],
  ['sin excluir la aplicación cancelada', "AND btrim(coalesce(h.c43, '')) <> 'C'", ''],
  ['el vale sin OC se encadena igual (sin pedir c20 = 35)', 'AND v.c20 = 35 AND', 'AND'],
];

// ─── C. El control en JS: encadena y clasifica SIN la vista ───────────────────────────────────
function clasificarJs(p_ap, p_oc, f2, f3) {
  if (p_oc == null) return { estado: 'sin_oc' };
  if (!(p_oc > 0 && p_ap > 0)) return { estado: 'sin_precio' };
  const coc = Math.max(p_oc, p_ap) / Math.min(p_oc, p_ap); const mayor = p_oc > p_ap;
  let k = 1;
  if (coc >= 2) {
    const cand = [...new Set([f2, f3, f2 && f3 ? f3 / f2 : null].filter((x) => x && x > 1.0001))]
      .map((x) => ({ x, d: Math.abs(Math.log(coc / x)) })).filter((o) => coc / o.x > 0.5 && coc / o.x < 2).sort((a, b) => a.d - b.d);
    if (!cand.length) return { estado: 'otra_escala_sin_factor' };
    if (cand[1] && cand[1].d < 2 * cand[0].d && cand[0].d > 0.005) return { estado: 'otra_escala_ambigua' };
    k = cand[0].x;
  }
  const peq = k === 1 ? p_oc : mayor ? p_oc / k : p_oc * k;
  const estado = Math.abs(p_ap - peq) <= 0.01 || Math.abs(p_ap / peq - 1) <= 0.005 ? 'igual' : p_ap > peq ? 'sube' : 'baja';
  return { estado, k, mayor };
}

(async () => {
  console.log('\n[PQ.157] commercial.v_application_line_cost — el SQL de la migración\n');

  console.log(' A. Casos armados (VALUES, sólo lectura)');
  let base;
  try { base = await soloLectura((trx) => correrCasos(trx, MIG.SELECT_SQL)); } catch (e) { noMedido(`no hay Postgres: ${e.message}`); return salir(); }
  for (const [m, c] of juzgar(base)) ok(c, m);
  ok(base.every((r) => MIG.ESTADOS.includes(r.estado_costo)), `todo estado está en el catálogo (${MIG.ESTADOS.length})`);

  console.log('\n B. Mutantes: cada guarda rota TIENE que poner rojo algún caso');
  for (const [nombre, de, a] of MUTANTES) {
    if (!MIG.SELECT_SQL.includes(de)) { ok(false, `el mutante «${nombre}» no encontró su texto (¿cambió la vista?)`); continue; }
    const filas = await soloLectura((trx) => correrCasos(trx, MIG.SELECT_SQL.split(de).join(a)));
    const rojos = juzgar(filas).filter(([, c]) => !c).map(([m]) => m);
    ok(rojos.length > 0, `${nombre} → ${rojos.length ? `rojo (${rojos.length}): «${rojos[0].slice(0, 60)}…»` : 'SIGUE VERDE'}`);
  }

  console.log('\n C. Contra los datos reales (prod, sólo lectura)');
  const aps = await soloLectura(async (trx) => {
    if (!(await trx.raw(`SELECT to_regclass('kepler_ods.kdm1') IS NOT NULL AS t`)).rows[0].t) return 0;
    return (await trx.raw(`SELECT count(*)::int AS n FROM kepler_ods.kdm1 WHERE c2='X' AND c3='A' AND c4=20`)).rows[0].n;
  }).catch(() => 0);
  if (aps < 5000) { noMedido(`esta base tiene ${aps} aplicaciones X-A-20 en el ODS (CI): el control y el testigo se miden contra prod`); return salir(); }

  await soloLectura(async (trx) => {
    const V = (await trx.raw(`SELECT * FROM (${MIG.SELECT_SQL}) v WHERE fecha_aplicacion >= current_date - 60`)).rows;
    const llave = (s, a, sub, f, r) => `${s}|${a}|${Number(sub)}|${f}|${Number(r)}`;
    // La cadena en JS: aplicación → orden de entrada → vale → OC, leyendo kdm2 por las llaves de origen.
    const L20 = (await trx.raw(`
      SELECT a.sucursal, a.c1, a.c5, a.c6, a.c7, btrim(a.c8) sku, a.c12::float p, a.c20::int o, a.c21, a.c22, a.c23
        FROM kepler_ods.kdm1 h JOIN kepler_ods.kdm2 a ON a.sucursal=h.sucursal AND a.c1=h.c1 AND a.c2=h.c2 AND a.c3=h.c3 AND a.c4=h.c4 AND a.c5=h.c5 AND a.c6=h.c6
       WHERE h.c2='X' AND h.c3='A' AND h.c4=20 AND btrim(h.c1)=h.sucursal AND btrim(coalesce(h.c43,''))<>'C' AND btrim(h.c10)<>'CL005'
         AND h.c9::date >= current_date - 60`)).rows;
    const lineas = async (grupo, filas) => {
      const keys = filas.map((x) => ({ s: x.sucursal, a: x.c1, sub: Number(x.c21), f: x.c22, r: Number(x.c23) }));
      const m = new Map();
      for (let i = 0; i < keys.length; i += 5000) {
        const rs = (await trx.raw(`SELECT l.sucursal, l.c1, l.c5, l.c6, l.c7, l.c12::float p, l.c20::int o, l.c21, l.c22, l.c23
            FROM jsonb_to_recordset(?::jsonb) k(s text, a text, sub numeric, f text, r numeric)
            JOIN kepler_ods.kdm2 l ON l.sucursal=k.s AND l.c1=k.a AND l.c2='X' AND l.c3='A' AND l.c4=${grupo} AND l.c5=k.sub AND l.c6=k.f AND l.c7=k.r`,
          [JSON.stringify(keys.slice(i, i + 5000))])).rows;
        for (const x of rs) m.set(llave(x.sucursal, x.c1, x.c5, x.c6, x.c7), x);
      }
      return m;
    };
    const OE = await lineas(40, L20.filter((x) => x.o === 40));
    const prox = (m, x) => m.get(llave(x.sucursal, x.c1, x.c21, x.c22, x.c23));
    const VA = await lineas(37, [...OE.values()].filter((x) => x.o === 37));
    const OC = await lineas(35, [...VA.values()].filter((x) => x.o === 35));
    const FI = new Map((await trx.raw(`SELECT btrim(sucursal) s, btrim(c1) sku, c81::float f2, c84::float f3 FROM kepler_ods.kdii`)).rows.map((r) => [`${r.s}|${r.sku}`, r]));
    const js = new Map();
    for (const a of L20) {
      const oe = a.o === 40 ? prox(OE, a) : null; const va = oe && oe.o === 37 ? prox(VA, oe) : null; const oc = va && va.o === 35 ? prox(OC, va) : null;
      const fi = FI.get(`${a.sucursal}|${a.sku}`);
      js.set(llave(a.sucursal, a.c1, a.c5, a.c6, a.c7), clasificarJs(a.p, oc ? oc.p : null, fi ? fi.f2 : null, fi ? fi.f3 : null));
    }
    let iguales = 0; const malos = [];
    for (const r of V) {
      const j = js.get(llave(r.sucursal, r.almacen, r.subtipo, r.folio, r.renglon));
      if (j && j.estado === r.estado_costo) iguales++; else if (malos.length < 3) malos.push(`${r.sucursal}/${r.folio}/${r.renglon}: vista ${r.estado_costo}, JS ${j && j.estado}`);
    }
    ok(V.length >= 5000 && iguales === V.length && js.size === V.length,
      `CONTROL: la cadena y la clasificación en JS dan el MISMO estado en ${iguales} de ${V.length} renglones (JS: ${js.size}; medido 11,908 de 11,908)${malos.length ? ` — ${malos.join(' · ')}` : ''}`);

    // Testigo de la escala: ¿la cantidad cambió por el mismo factor? Placebo: el doble del factor.
    const Q = new Map((await trx.raw(`
      SELECT a.sucursal||'|'||a.c1||'|'||a.c5::int||'|'||a.c6||'|'||a.c7::int AS k, a.c9::float q_ap, oc.c9::float q_oc
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 a ON a.sucursal=h.sucursal AND a.c1=h.c1 AND a.c2='X' AND a.c3='A' AND a.c4=20 AND a.c5=h.c5 AND a.c6=h.c6
        JOIN kepler_ods.kdm2 oe ON oe.sucursal=a.sucursal AND oe.c1=a.c1 AND oe.c2='X' AND oe.c3='A' AND oe.c4=40 AND a.c20=40 AND oe.c5=a.c21 AND oe.c6=a.c22 AND oe.c7=a.c23
        JOIN kepler_ods.kdm2 v ON v.sucursal=oe.sucursal AND v.c1=oe.c1 AND v.c2='X' AND v.c3='A' AND v.c4=37 AND oe.c20=37 AND v.c5=oe.c21 AND v.c6=oe.c22 AND v.c7=oe.c23
        JOIN kepler_ods.kdm2 oc ON oc.sucursal=v.sucursal AND oc.c1=v.c1 AND oc.c2='X' AND oc.c3='A' AND oc.c4=35 AND v.c20=35 AND oc.c5=v.c21 AND oc.c6=v.c22 AND oc.c7=v.c23
       WHERE h.c2='X' AND h.c3='A' AND h.c4=20 AND h.c9::date >= current_date - 60`)).rows.map((r) => [r.k, r]));
    let esc = 0, casa = 0, placebo = 0;
    for (const r of V) {
      if (!['oc_en_unidad_mayor', 'aplicacion_en_unidad_mayor'].includes(r.escala) || r.factor_escala == null) continue;
      const q = Q.get(`${r.sucursal}|${r.almacen}|${Number(r.subtipo)}|${r.folio}|${Number(r.renglon)}`); if (!q || !(q.q_oc > 0)) continue;
      const k = Number(r.factor_escala); const enOc = (kk) => (r.escala === 'oc_en_unidad_mayor' ? q.q_ap / kk : q.q_ap * kk);
      esc++; if (Math.abs(enOc(k) / q.q_oc - 1) <= 0.01) casa++; if (Math.abs(enOc(2 * k) / q.q_oc - 1) <= 0.01) placebo++;
    }
    if (esc < 200) noMedido(`sólo ${esc} renglones escalados en 60 días: muy pocos para el testigo`);
    else ok(casa / esc >= 0.8 && placebo / esc <= 0.05,
      `TESTIGO de la escala: la cantidad cambió por el MISMO factor en ${casa} de ${esc} (${(casa / esc * 100).toFixed(1)} %; piso 80 %, medido 87 %) · placebo con el doble del factor ${placebo} (${(placebo / esc * 100).toFixed(1)} %)`);
  });
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
