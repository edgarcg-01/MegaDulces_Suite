/* eslint-disable no-console */
/**
 * [VP.1.2] CANDADO del sell-out — el test de paridad que el código AFIRMABA que existía.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `database/migrations-newdb/20260904100000_v_sellout_daily.js` dice, textual:
 *
 *     // VERBATIM del service — si tocás uno, tocá el otro (test de paridad lo verifica).
 *     ... un test de regresión asegura que empatan (si divergen, alguien tocó uno solo).
 *
 * No existía. Grep de `v_sellout_daily` en todo el repo: 6 hits, ninguno un archivo de prueba. El
 * reporte más consultado del negocio iba de la migración a la pantalla sin tocar una sola aserción,
 * y su dedup Kepler↔Wincaja es un predicado de FECHAS escrito a mano en varios archivos. Si alguien
 * mueve una fecha de corte en un lado, la sucursal 01 en julio-2026 se cuenta dos veces —o cero— y
 * nada lo detecta. Ya pasó: dos commits de esta misma superficie dicen "recupera $8.07M/mes" y
 * "$4.44M/mes que la copia tiraba".
 *
 * ── LAS CUATRO PREGUNTAS ─────────────────────────────────────────────────────────────────
 *  1. ¿Los literales de corte empatan entre todas las copias vivas?
 *  2. ¿El dedup no DUPLICA? (ninguna sucursal-día con las dos fuentes a la vez)
 *  3. ¿El dedup no PIERDE? (el complemento cubre; un hueco es plata que desaparece en silencio)
 *  4. ¿El rollup mensual empata con la vista diaria, al peso, en meses cerrados?
 *
 * ── POR QUÉ HAY UN TERCER ESTADO ─────────────────────────────────────────────────────────
 * Los bloques 2-4 necesitan datos de las DOS piernas. En un destino donde `mv_wincaja_sales_daily`
 * está vacía, "cero traslapes" es cierto y no significa nada. Pasarlo como ✔ es exactamente el
 * patrón que esta fase persigue —el verde que no midió nada—, así que se reporta **NO MEDIDO** y se
 * cuenta aparte. Un run limpio en un destino sin datos dice "3 OK · 0 fallas · 4 NO MEDIDOS", que se
 * lee como lo que es.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-sellout-parity.js
 */
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

/** Mapa de cutover: sucursal Wincaja ↔ sucursal Kepler que la reemplaza, y desde cuándo. */
const CUTOVER = [
  { kepler: '01', wincaja: '10', desde: '2026-07-01', nombre: 'Padre Hidalgo' },
  { kepler: '02', wincaja: '42', desde: '2025-10-01', nombre: 'La Piedad' },
  { kepler: '06', wincaja: '50', desde: '2026-08-15', nombre: 'Canindo' },
];

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
/** Ni ✔ ni ✖: no se pudo medir. Se cuenta aparte para que el resumen no mienta. */
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => { try { return fs.readFileSync(path.join(RAIZ, rel), 'utf8'); } catch { return null; } };

/** Saca los pares (sucursal, fecha) del predicado de dedup, sea cual sea el alias/orden. */
function fechasPorSucursal(src, sucursales) {
  const out = {};
  for (const suc of sucursales) {
    const rx = new RegExp(`source_branch\\s*=\\s*'${suc}'[\\s\\S]{0,80}?DATE\\s*'(\\d{4}-\\d{2}-\\d{2})'`, 'g');
    const hits = [...src.matchAll(rx)].map((m) => m[1]);
    if (hits.length) out[suc] = hits[0];
  }
  return out;
}

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log('\n=== SELL-OUT · paridad del dedup Kepler↔Wincaja y del rollup ===\n');
  const q = async (s, p) => (await c.query(s, p)).rows;

  // ── 1. Los literales de corte empatan entre TODAS las copias vivas ───────────────────────
  // El predicado no tiene un dueño único: vive en las migraciones de las dos vistas y en el
  // proyector del feed. Mientras siga copiado (VP.1.1 lo centraliza), esto es lo que impide que se
  // separen en silencio.
  console.log('1 · LITERALES DE CORTE (mientras el predicado siga copiado)');
  const COPIAS = [
    ['database/migrations-newdb/20260904100000_v_sellout_daily.js', ['01', '02', '06']],
    ['database/migrations-newdb/20260903130000_v_sales_blended.js', ['01', '02', '06']],
  ];
  const canon = Object.fromEntries(CUTOVER.map((x) => [x.kepler, x.desde]));
  for (const [rel, sucs] of COPIAS) {
    const src = leer(rel);
    const nombre = rel.split('/').pop();
    check(`${nombre} se puede leer`, !!src);
    if (!src) continue;
    const got = fechasPorSucursal(src, sucs);
    check(`${nombre} declara las 3 fechas de corte`, Object.keys(got).length === sucs.length,
      `encontradas: ${JSON.stringify(got)}`);
    for (const suc of sucs) {
      if (!got[suc]) continue;
      check(`${nombre} · sucursal ${suc} corta el ${canon[suc]}`, got[suc] === canon[suc],
        `dice ${got[suc]}, el canon de este test dice ${canon[suc]}`);
    }
  }

  // El complemento tiene que ser EXACTO: la fecha con la que Kepler ARRANCA es la misma con la que
  // Wincaja TERMINA. Si una de las dos se mueve sola, aparece el hueco o el doble conteo.
  const vsd = leer('database/migrations-newdb/20260904100000_v_sellout_daily.js');
  if (vsd) {
    const win = fechasPorSucursal(vsd, CUTOVER.map((x) => x.wincaja));
    check('el predicado Wincaja usa las MISMAS 3 fechas que el de Kepler (complemento exacto)',
      CUTOVER.every((x) => win[x.wincaja] === x.desde),
      `wincaja: ${JSON.stringify(win)}`);
    check('Kepler mira hacia ADELANTE (>=) y Wincaja hacia ATRÁS (<)',
      /business_date\s*>=\s*DATE/.test(vsd) && /business_date\s*<\s*DATE/.test(vsd),
      'si los dos miran para el mismo lado, el cutover duplica o vacía');
  }

  // ── ¿hay con qué medir los bloques de datos? ─────────────────────────────────────────────
  const objs = await q(
    `SELECT c.relname, c.relkind, c.relispopulated FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='analytics' AND c.relname IN ('v_sellout_daily','mv_sellout_monthly','mv_kepler_sales_daily','mv_wincaja_sales_daily')`);
  const tiene = (n) => objs.some((o) => o.relname === n && (o.relkind === 'v' || o.relispopulated));
  const vista = tiene('v_sellout_daily');
  check('analytics.v_sellout_daily existe', vista);

  let piernas = { kepler: 0, wincaja: 0 };
  if (vista) {
    const r = await q(`SELECT source, count(*)::int n FROM analytics.v_sellout_daily GROUP BY 1`);
    for (const x of r) piernas[x.source] = x.n;
    console.log(`  ⓘ universo: kepler ${piernas.kepler || 0} filas · wincaja ${piernas.wincaja || 0} filas`);
  }
  const dosPiernas = vista && piernas.kepler > 0 && piernas.wincaja > 0;

  // ── 2. El dedup no DUPLICA ───────────────────────────────────────────────────────────────
  console.log('\n2 · TRASLAPE (doble conteo en el mes de cutover)');
  if (!dosPiernas) {
    noMedido('traslape Kepler↔Wincaja = 0',
      `hacen falta las DOS piernas con datos (kepler=${piernas.kepler || 0}, wincaja=${piernas.wincaja || 0}). ` +
      'Con una pierna vacía "cero traslapes" es cierto y no prueba nada.');
  } else {
    const dup = await q(`
      WITH m(kepler, wincaja) AS (VALUES ${CUTOVER.map((x) => `('${x.kepler}','${x.wincaja}')`).join(',')}),
      norm AS (
        SELECT s.business_date,
               COALESCE(m.kepler, s.source_branch) AS sucursal,
               s.source, s.monto
          FROM analytics.v_sellout_daily s
          LEFT JOIN m ON m.wincaja = s.source_branch
         WHERE s.source_branch <> ''
      )
      SELECT sucursal, business_date::date AS dia,
             sum(monto) FILTER (WHERE source='kepler')::numeric(14,2)  AS kepler,
             sum(monto) FILTER (WHERE source='wincaja')::numeric(14,2) AS wincaja
        FROM norm
       GROUP BY 1,2
      HAVING count(DISTINCT source) > 1
       ORDER BY 2 DESC LIMIT 10`);
    check('ninguna sucursal-día trae las DOS fuentes (cero doble conteo)', dup.length === 0,
      dup.length ? `${dup.length}+ días duplicados, ej: ${dup.slice(0, 3).map((d) => `${d.sucursal} ${String(d.dia).slice(0, 10)} k=$${d.kepler} w=$${d.wincaja}`).join(' · ')}` : '');
  }

  // ── 3. El dedup no PIERDE ────────────────────────────────────────────────────────────────
  // El traslape se ve; el HUECO no. Un día sin ninguna de las dos piernas es venta que desapareció
  // del reporte sin que nada falle — es la forma del bug que costó $8.07M/mes.
  console.log('\n3 · HUECO (el complemento cubre los dos lados del corte)');
  if (!dosPiernas) {
    noMedido('el complemento cubre el corte', 'idem: hace falta la pierna Wincaja con datos');
  } else {
    for (const x of CUTOVER) {
      const r = (await q(`
        SELECT
          count(*) FILTER (WHERE source='wincaja' AND business_date <  DATE '${x.desde}')::int AS win_antes,
          count(*) FILTER (WHERE source='kepler'  AND business_date >= DATE '${x.desde}')::int AS kep_desde
          FROM analytics.v_sellout_daily
         WHERE source_branch IN ('${x.kepler}','${x.wincaja}')`))[0];
      check(`${x.nombre} (${x.wincaja}→${x.kepler}): hay venta de los DOS lados del corte ${x.desde}`,
        Number(r.win_antes) > 0 && Number(r.kep_desde) > 0,
        `wincaja antes=${r.win_antes} · kepler desde=${r.kep_desde}`);
    }
  }

  // ── 4. El rollup mensual empata con la vista diaria, al peso ─────────────────────────────
  // La migración dice que la paridad es "ESTRUCTURAL por construcción" (el rollup se define DESDE la
  // vista). Cierto — y aun así se mide: la estructura garantiza la fórmula, no que el REFRESH haya
  // corrido. Un rollup materializado hace cinco noches empata con su definición y no con el dato.
  console.log('\n4 · ROLLUP ↔ VISTA (meses cerrados, al peso)');
  if (!vista || !tiene('mv_sellout_monthly')) {
    noMedido('paridad rollup ↔ vista', 'falta v_sellout_daily o mv_sellout_monthly poblada');
  } else {
    const meses = await q(
      `SELECT year_month FROM analytics.mv_sellout_monthly
        WHERE year_month < to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM')
        GROUP BY 1 ORDER BY 1 DESC LIMIT 3`);
    if (!meses.length) {
      noMedido('paridad rollup ↔ vista', 'el rollup no tiene meses CERRADOS cargados');
    } else {
      for (const { year_month } of meses) {
        const r = (await q(`
          SELECT
            (SELECT sum(monto) FROM analytics.mv_sellout_monthly WHERE year_month=$1)::numeric(14,2) AS mv,
            (SELECT sum(monto) FROM analytics.v_sellout_daily
              WHERE to_char(business_date,'YYYY-MM')=$1)::numeric(14,2) AS vista`, [year_month]))[0];
        const d = Math.abs(Number(r.mv || 0) - Number(r.vista || 0));
        check(`${year_month}: rollup == vista (Δ ${d.toFixed(2)})`, d < 0.01,
          `mv=$${r.mv} vista=$${r.vista}`);
      }
    }
  }

  await c.end();
  const resumen = `${ok} OK · ${fail} falla(s)` + (nm ? ` · ${nm} NO MEDIDO(S)` : '');
  console.log(`\n  ${resumen}\n`);
  if (nm) console.log('  ⓘ "NO MEDIDO" no es "pasó": es que en este destino no había con qué comprobarlo.\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
