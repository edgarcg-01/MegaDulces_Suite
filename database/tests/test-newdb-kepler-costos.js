'use strict';
/**
 * `[CAT-COSTO.6]` Candado de la fuente única de los tres costos de Kepler
 * (`analytics.mv_kepler_costos`).
 *
 *   node database/tests/test-newdb-kepler-costos.js
 *
 * Sólo lee.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 *  1. **Segunda implementación.** Para SKUs reales con compra y venta, se recalcula en JS —desde
 *     `kdm1`/`kdm2`/`kdij` crudos, sin el SQL de la migración— el último costo (XA2001) y el
 *     promedio (última salida del kardex), y tiene que dar lo mismo que la fuente. Comparar la
 *     matview consigo misma pasaría la lógica rota en verde (lección de IC.0).
 *  2. **El último costo sale SÓLO de una compra** (prueba NEGATIVA): el folio que publica tiene que
 *     existir como `X-A-20` serie 1 en esa sucursal. Si la fuente tomara la última ENTRADA (un
 *     traspaso `U-A-50` o un ajuste), ese folio no estaría ahí.
 *  3. **Ningún hueco mudo**: un costo NULL siempre lleva su `*_motivo`.
 *  4. **La unidad**: la mediana último/estándar y promedio/estándar se pega a 1 (los tres están en
 *     la base de la ficha). Si se pegara a un factor de caja, la conversión se rompió.
 *  5. **No es espejo** (ADR-059 R5): el último costo difiere del estándar en una parte medible de
 *     las fichas. Si coincidieran en casi todas, la fuente estaría copiando el estándar.
 *  6. **La premisa que refutó a la documentación** (vigilancia): `kdik.c16` sigue siendo el costo
 *     de la ÚLTIMA ENTRADA, no el promedio acumulado `c8/c5`. Medido 2026-10-15: 98.57 % contra
 *     0.02 % en las filas donde las dos hipótesis difieren. Si esto se invierte, Kepler cambió de
 *     comportamiento y las etiquetas de la pantalla vuelven a estar mal.
 *  7. **Metadata** (sólo con la matview aplicada): `app_runtime` puede leerla — con `USAGE` del
 *     schema, que `has_table_privilege` no revisa (lección de CP.8.44).
 *
 * Si la matview no existe o nunca se refrescó, se ejerce el SELECT de la migración y se DECLARA
 * (NO MEDIDO para lo que sólo la matview puede decir).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { resolveReadTarget } = require('./_lib/assert-safe-target');
const { url } = resolveReadTarget('test-newdb-kepler-costos');
const knex = require('knex')({ client: 'pg', connection: { connectionString: url, statement_timeout: 180000 }, pool: { min: 0, max: 2 } });
const MIG = require(path.resolve(__dirname, '..', 'migrations-newdb', '20261015115146_mv_kepler_costos.js'));

let ok = 0;
let bad = 0;
let nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok += 1; console.log(`  ✔ ${name}`); }
  else { bad += 1; console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 500)}` : ''}`); }
};
const noMedido = (name, porque) => { nm += 1; console.log(`  ○ NO MEDIDO: ${name} — ${porque}`); };
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[^0-9.-]/g, '');
  return s === '' ? null : Number(s);
};
const cerca = (a, b, tol = 0.0005) => a !== null && b !== null && Math.abs(a - b) <= Math.max(0.0001, Math.abs(b) * tol);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

(async () => {
  console.log('\n=== [CAT-COSTO.6] Los tres costos de Kepler ===\n');
  const { rows: [meta] } = await knex.raw(`
    SELECT to_regclass('analytics.mv_kepler_costos') AS mv,
           (SELECT relispopulated FROM pg_class WHERE oid = to_regclass('analytics.mv_kepler_costos')) AS poblada`);
  const usaMv = !!(meta.mv && meta.poblada);
  console.log(usaMv
    ? '  ⓘ se mide la matview aplicada'
    : `  ⓘ la matview ${meta.mv ? 'existe pero NO se ha refrescado' : 'NO está aplicada'}: se ejerce el cuerpo de la migración`);
  const fuente = usaMv ? 'analytics.mv_kepler_costos' : `(${MIG._cuerpo()})`;

  // Se trae UNA vez (el cuerpo cuesta ~11 s): las fichas de la muestra y los agregados.
  const { rows: [agg] } = await knex.raw(`
    WITH x AS (SELECT * FROM ${fuente} f)
    SELECT COUNT(*)::int AS fichas,
           COUNT(*) FILTER (WHERE costo_estandar IS NULL AND estandar_motivo IS NULL)::int AS mudo_est,
           COUNT(*) FILTER (WHERE costo_ultimo   IS NULL AND ultimo_motivo   IS NULL)::int AS mudo_ult,
           COUNT(*) FILTER (WHERE costo_promedio IS NULL AND promedio_motivo IS NULL)::int AS mudo_prom,
           COUNT(*) FILTER (WHERE costo_ultimo > 0 AND costo_estandar > 0)::int            AS par_ult,
           COUNT(*) FILTER (WHERE costo_ultimo > 0 AND costo_estandar > 0
                              AND abs(costo_ultimo / costo_estandar - 1) > 0.01)::int      AS ult_distinto,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_ultimo / costo_estandar)
             FILTER (WHERE costo_ultimo > 0 AND costo_estandar > 0)                        AS med_ult,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_promedio / costo_estandar)
             FILTER (WHERE costo_promedio > 0 AND costo_estandar > 0)                      AS med_prom
      FROM x`);
  if (!(agg.fichas > 0)) {
    noMedido('todo', 'esta base no tiene fichas de Kepler (kepler_ods vacío)');
    console.log(`\n${ok} ✔ · ${bad} ✗ · ${nm} no medido\n`);
    await knex.destroy();
    process.exit(0);
  }

  // ── 1 y 2. Segunda implementación + el último costo sale SÓLO de una compra ───────────────
  console.log('\n── 1. La fuente contra un recálculo en JS desde las tablas crudas ──');
  const { rows: muestra } = await knex.raw(`
    SELECT * FROM ${fuente} f
     WHERE ultimo_origen = 'propia' AND costo_ultimo IS NOT NULL AND costo_promedio IS NOT NULL
       AND ultimo_fecha >= CURRENT_DATE - 60
     ORDER BY md5(sucursal || sku) LIMIT 12`);
  if (!muestra.length) noMedido('segunda implementación', 'ninguna ficha con compra propia y salida en 60 días');

  for (const m of muestra) {
    // ÚLTIMO: los renglones crudos de las XA2001 de esa sucursal y SKU; los filtros, acá en JS.
    const { rows: comp } = await knex.raw(`
      SELECT btrim(h.c1) alm, h.c43, h.c68, btrim(h.c6::text) folio, btrim(l.c5::text) serie, l.c9, l.c13, l.c11
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
                              AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
       WHERE h.sucursal = ? AND btrim(l.c8) = ?
         AND l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20'`, [m.sucursal, m.sku]);
    const hoy = new Date().toISOString().slice(0, 10);
    const validos = comp.filter((r) => r.alm === m.sucursal && (r.c43 || '').trim() !== 'C' && r.serie === '1'
      && iso(r.c68) <= hoy && num(r.c9) > 0 && num(r.c13) > 0);
    const porDoc = {};
    for (const r of validos) {
      const k = `${iso(r.c68)}|${r.folio}|${(r.c11 || '').trim().toUpperCase()}`;
      porDoc[k] = porDoc[k] || { fecha: iso(r.c68), folio: r.folio, unidad: (r.c11 || '').trim().toUpperCase(), imp: 0, q: 0 };
      porDoc[k].imp += num(r.c13); porDoc[k].q += num(r.c9);
    }
    const ult = Object.values(porDoc).sort((a, b) => (b.fecha + b.folio).localeCompare(a.fecha + a.folio))[0];
    const f = { u1: m.unidad_base, u2: m.unidad_dos, f2: num(m.factor_dos), u3: m.unidad_tres, f3: num(m.factor_tres) };
    const fac = (u) => (u === f.u1 ? 1 : u === f.u2 && f.f2 > 0 ? f.f2 : u === f.u3 && f.f3 > 0 ? f.f3 : null);
    const ultJs = ult && fac(ult.unidad) ? ult.imp / ult.q / fac(ult.unidad) : null;
    t(`ÚLTIMO ${m.sucursal}/${m.sku}: ${num(m.costo_ultimo)} = recálculo ${ultJs && ultJs.toFixed(6)} (folio ${m.ultimo_folio})`,
      cerca(num(m.costo_ultimo), ultJs) && ult && ult.folio === m.ultimo_folio, { pub: m.costo_ultimo, js: ultJs, ult });

    // PROMEDIO: la última salida del kardex, por día y unidad, en JS.
    const { rows: sal } = await knex.raw(`
      SELECT c10::date f, upper(btrim(c12)) u, c11::float q, c13::float imp
        FROM kepler_ods.kdij
       WHERE sucursal = ? AND btrim(c1) = sucursal AND c2 = 1 AND btrim(c3) = ? AND c30 = 'S'
         AND c11 > 0 AND c13 > 0 AND c10 >= CURRENT_DATE - 365`, [m.sucursal, m.sku]);
    const dias = {};
    for (const r of sal) {
      const k = `${iso(r.f)}|${r.u}`;
      dias[k] = dias[k] || { f: iso(r.f), u: r.u, q: 0, imp: 0 };
      dias[k].q += r.q; dias[k].imp += r.imp;
    }
    const ds = Object.values(dias).sort((a, b) => b.f.localeCompare(a.f) || b.q - a.q)[0];
    const promJs = ds && fac(ds.u) ? ds.imp / ds.q / fac(ds.u) : null;
    t(`PROMEDIO ${m.sucursal}/${m.sku}: ${num(m.costo_promedio)} = recálculo ${promJs && promJs.toFixed(6)} (${ds && ds.f})`,
      cerca(num(m.costo_promedio), promJs, 0.001), { pub: m.costo_promedio, js: promJs, ds });
  }

  // 2. PRUEBA NEGATIVA: el folio publicado como último costo existe como XA2001 en esa sucursal.
  console.log('\n── 2. El último costo sale SÓLO de una compra (XA2001) ──');
  const { rows: [neg] } = await knex.raw(`
    WITH x AS (SELECT * FROM ${fuente} f WHERE costo_ultimo IS NOT NULL ORDER BY md5(sucursal || sku) LIMIT 300)
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM kepler_ods.kdm1 h
              WHERE h.sucursal = x.ultimo_sucursal AND h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20'
                AND btrim(h.c5::text) = '1' AND btrim(h.c6::text) = x.ultimo_folio))::int AS es_xa2001,
           COUNT(*) FILTER (WHERE x.ultimo_folio = x.ultima_entrada_doc)::int AS confundido
      FROM x`);
  t(`los ${neg.n} folios de último costo de la muestra son XA2001 de su sucursal (${neg.es_xa2001})`, neg.es_xa2001 === neg.n, neg);

  // ── 3. Ningún hueco mudo ─────────────────────────────────────────────────────────────────
  console.log('\n── 3. Lo que falta se declara ──');
  t(`ningún costo NULL sin motivo (estándar ${agg.mudo_est} · último ${agg.mudo_ult} · promedio ${agg.mudo_prom})`,
    agg.mudo_est === 0 && agg.mudo_ult === 0 && agg.mudo_prom === 0, agg);

  // ── 4. La unidad ─────────────────────────────────────────────────────────────────────────
  console.log('\n── 4. Los tres costos están en la misma unidad (la base de la ficha) ──');
  t(`mediana último/estándar = ${Number(agg.med_ult).toFixed(4)} ∈ [0.8, 1.3]`, Number(agg.med_ult) > 0.8 && Number(agg.med_ult) < 1.3, agg.med_ult);
  t(`mediana promedio/estándar = ${Number(agg.med_prom).toFixed(4)} ∈ [0.8, 1.3]`, Number(agg.med_prom) > 0.8 && Number(agg.med_prom) < 1.3, agg.med_prom);

  // ── 5. No es espejo ──────────────────────────────────────────────────────────────────────
  console.log('\n── 5. No es espejo ──');
  const pct = (100 * agg.ult_distinto) / Math.max(1, agg.par_ult);
  t(`el último costo difiere del estándar (±1 %) en ${pct.toFixed(1)} % de las fichas (> 5 %)`, pct > 5, agg);

  // ── 6. La premisa: kdik.c16 = costo de la ÚLTIMA ENTRADA ─────────────────────────────────
  console.log('\n── 6. Vigilancia: kdik.c16 es la última entrada, no el promedio acumulado ──');
  const { rows: [p] } = await knex.raw(`
    WITH k AS (
      SELECT sucursal, btrim(c2) sku, c16::numeric c16, c8::numeric / NULLIF(c5::numeric, 0) h1
        FROM kepler_ods.kdik
       WHERE btrim(c1) = sucursal AND c5 > 0 AND c16 > 0 AND c16 < 'Infinity'::float8
       ORDER BY md5(sucursal || btrim(c2)) LIMIT 4000),
    ult AS (
      SELECT DISTINCT ON (k.sucursal, k.sku) k.sucursal, k.sku, j.c10::date f
        FROM k JOIN kepler_ods.kdij j
          ON j.sucursal = k.sucursal AND btrim(j.c1) = k.sucursal AND j.c2 = 1 AND btrim(j.c3) = k.sku
       WHERE j.c30 = 'E' AND j.c11 > 0 AND j.c13 > 0
       ORDER BY k.sucursal, k.sku, j.c10 DESC),
    dia AS (
      SELECT u.sucursal, u.sku, array_agg(j.c13::numeric / j.c11::numeric) costos
        FROM ult u JOIN kepler_ods.kdij j
          ON j.sucursal = u.sucursal AND btrim(j.c1) = u.sucursal AND j.c2 = 1 AND btrim(j.c3) = u.sku
         AND j.c10::date = u.f AND j.c30 = 'E' AND j.c11 > 0 AND j.c13 > 0
       GROUP BY 1, 2)
    SELECT COUNT(*)::int AS difieren,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(d.costos) c WHERE abs(k.c16 / c - 1) <= 0.001))::int AS h2,
           COUNT(*) FILTER (WHERE abs(k.c16 / k.h1 - 1) <= 0.001)::int AS h1
      FROM k JOIN dia d USING (sucursal, sku)
     WHERE NOT EXISTS (SELECT 1 FROM unnest(d.costos) c WHERE abs(k.h1 / c - 1) <= 0.001)`);
  if (!(p.difieren > 30)) {
    noMedido('premisa de c16', `sólo ${p.difieren} filas donde las dos hipótesis difieren`);
  } else {
    t(`c16 = última entrada en ${(100 * p.h2 / p.difieren).toFixed(1)} % de ${p.difieren} filas discriminantes (≥ 90 %)`, p.h2 / p.difieren >= 0.9, p);
    t(`c16 = promedio acumulado c8/c5 en ${(100 * p.h1 / p.difieren).toFixed(1)} % de esas filas (≤ 5 %)`, p.h1 / p.difieren <= 0.05, p);
  }

  // ── 7. Metadata ──────────────────────────────────────────────────────────────────────────
  console.log('\n── 7. Metadata ──');
  if (meta.mv) {
    const { rows: [g] } = await knex.raw(`
      SELECT has_schema_privilege('app_runtime', 'analytics', 'USAGE') AS usage_schema,
             has_table_privilege('app_runtime', 'analytics.mv_kepler_costos', 'SELECT') AS select_mv`);
    t('app_runtime tiene USAGE del schema analytics y SELECT de la matview', g.usage_schema && g.select_mv, g);
  } else {
    noMedido('metadata', 'la matview no está aplicada en esta base');
  }

  console.log(`\n${ok} ✔ · ${bad} ✗ · ${nm} no medido\n`);
  await knex.destroy();
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  await knex.destroy();
  process.exit(1);
});
