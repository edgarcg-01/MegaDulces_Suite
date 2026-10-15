'use strict';
/**
 * `[MR.9.1]` Candado del margen contra el COSTO ESTÁNDAR (`analytics.v_margin_standard_daily` +
 * `analytics.mv_erp_margin_ficha_daily`).
 *
 *   node database/tests/test-newdb-margin-standard.js
 *
 * Sólo lee.
 *
 * ── Qué protege ─────────────────────────────────────────────────────────────────────────────
 *  1. **Una segunda implementación.** Para SKUs reales con mayoreo en los últimos 30 días cerrados,
 *     se recalcula en JS renglón por renglón (`kdm2` + `kdii`, sin el SQL de la migración) la venta neta
 *     y el costo de la ficha, y tiene que dar lo mismo que la matview (o que su cuerpo, si no está
 *     aplicada). Comparar la matview consigo misma pasaría la lógica rota en verde (lección de IC.0).
 *  2. **La unidad, con prueba NEGATIVA.** En un renglón vendido en un peldaño con factor > 1, el costo
 *     tiene que ser `c77 × c58 × c56` y NO `c77 × c58 × c9` (ese error ya costó el −261.79 % de MR.8).
 *  3. **Disjuntas.** Lo costeado con ticket más lo costeado con ficha no puede pasar de la venta de la
 *     celda: si se pasa, algo se cuenta dos veces.
 *  4. **No es espejo** (ADR-059 R5): el MISMO SKU tiene margen distinto entre sucursales, cosa que el
 *     álgebra `venta / (1 + markup)` no puede producir.
 *
 * Si la matview no existe o nunca se refrescó, se ejerce el SELECT de la migración acotado a 30 días y
 * se DECLARA (NO MEDIDO para lo que sólo la matview puede decir).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { resolveReadTarget } = require('./_lib/assert-safe-target');
const { url } = resolveReadTarget('test-newdb-margin-standard');
const knex = require('knex')({ client: 'pg', connection: url, pool: { min: 0, max: 2 } });
const MIG = require(path.resolve(__dirname, '..', 'migrations-newdb', '20261013234951_mv_erp_margin_ficha_daily.js'));

const TENANT = '00000000-0000-0000-0000-00000000d01c';
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

(async () => {
  console.log('\n=== [MR.9.1] Margen contra el costo estándar ===\n');
  const { rows: [meta] } = await knex.raw(`
    SELECT to_regclass('analytics.mv_erp_margin_ficha_daily') AS mv,
           to_regclass('analytics.v_margin_standard_daily')   AS v,
           (SELECT relispopulated FROM pg_class WHERE oid = to_regclass('analytics.mv_erp_margin_ficha_daily')) AS poblada`);
  const usaMv = !!(meta.mv && meta.poblada);
  console.log(usaMv
    ? '  ⓘ se mide la matview aplicada'
    : `  ⓘ la matview ${meta.mv ? 'existe pero NO se ha refrescado' : 'NO está aplicada'}: se ejerce el cuerpo de la migración (30 d)`);

  // Los 30 días CERRADOS (hasta ayer): hoy cambia entre el refresco y esta lectura.
  const fuente = usaMv
    ? `(SELECT * FROM analytics.mv_erp_margin_ficha_daily WHERE tenant_id = '${TENANT}'
         AND sale_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE - 1)`
    : `(${MIG._cuerpo(`h.c9::date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE - 1`)})`;

  // ── 1. Segunda implementación, sobre SKUs reales ──────────────────────────────────────────
  console.log('\n── 1. La matview contra un recálculo renglón por renglón en JS ──');
  const { rows: top } = await knex.raw(`
    SELECT sku, SUM(venta_neta) vn FROM ${fuente} f GROUP BY sku ORDER BY 2 DESC LIMIT 5`);
  if (!top.length) {
    noMedido('segunda implementación', 'no hay mayoreo U-D-8 en los últimos 30 días cerrados');
  }
  // Un SKU vendido en peldaño con factor > 1 (para la prueba de unidad).
  const { rows: [conPeldano] } = await knex.raw(`
    SELECT btrim(l.c8) sku
      FROM kepler_ods.kdm1 h
      JOIN kepler_ods.kdm2 l ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
                            AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
     WHERE h.c2 = 'U' AND h.c3 = 'D' AND btrim(h.c4::text) = '8'
       AND h.c9::date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE - 1
       AND NULLIF(regexp_replace(l.c58::text, '[^0-9.-]', '', 'g'), '')::numeric > 1
     LIMIT 1`);
  const skus = [...new Set([...top.map((r) => r.sku), ...(conPeldano ? [conPeldano.sku] : [])])];

  for (const sku of skus) {
    // Renglones crudos, sin el SQL de la migración: los filtros se aplican acá, en JS.
    const { rows: lineas } = await knex.raw(`
      SELECT btrim(h.sucursal) suc, btrim(h.c1) alm_h, btrim(l.c1) alm, h.c43, l.c11, l.c9, l.c56, l.c58,
             l.c13, l.c17, l.c18, l.c62, k.c77
        FROM kepler_ods.kdm1 h
        JOIN kepler_ods.kdm2 l ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
                              AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
        LEFT JOIN kepler_ods.kdii k ON k.sucursal = h.sucursal AND btrim(k.c1) = btrim(l.c8)
       WHERE h.c2 = 'U' AND h.c3 = 'D' AND btrim(h.c4::text) = '8'
         AND h.c9::date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE - 1
         AND btrim(l.c8) = ?`, [sku]);
    const { rows: mapa } = await knex.raw(
      `SELECT sucursal, almacen_erp, warehouse_code FROM analytics.erp_warehouse_map WHERE tenant_id = ?`, [TENANT]);
    const almacen = (suc, alm) => (mapa.find((m) => m.sucursal === suc && m.almacen_erp === alm) || {}).warehouse_code || suc;

    const esperado = {}; // warehouse_code -> { vn, vnf, cogs, cogsMalo }
    for (const r of lineas) {
      if (r.alm_h.slice(0, 2) !== r.suc) continue;                       // réplica cruzada
      if ((r.c43 || '').trim() === 'C') continue;                        // cancelado
      if ((r.c11 || '').trim() === 'SER') continue;                      // servicio
      const q = num(r.c9);
      if (!q) continue;                                                  // cantidad 0
      if ((num(r.c62) || 0) > 0) continue;                               // ya lo costea el árbitro
      const neto = num(r.c13) / (1 + Math.abs(num(r.c17) || 0) / 100 + Math.abs(num(r.c18) || 0) / 100);
      const c77 = num(r.c77);
      const f = num(r.c58);
      const qv = num(r.c56);
      const cogs = c77 > 0 ? (f > 0 && qv !== null ? c77 * f * qv : c77 * q) : null;
      const k = almacen(r.suc, r.alm);
      esperado[k] = esperado[k] || { vn: 0, vnf: 0, cogs: 0, cogsMalo: 0 };
      esperado[k].vn += neto;
      if (cogs !== null) {
        esperado[k].vnf += neto;
        esperado[k].cogs += cogs;
        esperado[k].cogsMalo += c77 * (f || 1) * q;                    // el error de unidad, a propósito
      }
    }
    const { rows: real } = await knex.raw(`
      SELECT warehouse_code, SUM(venta_neta) vn, SUM(venta_neta_ficha) vnf, SUM(cogs_ficha) cogs
        FROM ${fuente} f WHERE sku = ? GROUP BY 1`, [sku]);
    const difs = [];
    for (const [k, e] of Object.entries(esperado)) {
      const r = real.find((x) => x.warehouse_code === k);
      const d = (a, b) => Math.abs(Number(a || 0) - b);
      if (!r || d(r.vn, e.vn) > 0.5 || d(r.vnf, e.vnf) > 0.5 || d(r.cogs, e.cogs) > 0.5) {
        difs.push({ almacen: k, esperado: e, real: r || null });
      }
    }
    const sobran = real.filter((r) => !esperado[r.warehouse_code]);
    t(`SKU ${sku}: venta neta y costo de ficha = recálculo en JS (${Object.keys(esperado).length} almacén(es))`,
      difs.length === 0 && sobran.length === 0, { difs, sobran });

    if (conPeldano && sku === conPeldano.sku) {
      const malo = Object.values(esperado).reduce((s, e) => s + e.cogsMalo, 0);
      const bueno = Object.values(esperado).reduce((s, e) => s + e.cogs, 0);
      const pub = real.reduce((s, r) => s + Number(r.cogs || 0), 0);
      // PRUEBA NEGATIVA: con factor > 1, multiplicar por c9 da otro número, y la matview NO puede dar ése.
      t(`UNIDAD (SKU ${sku}, factor > 1): el costo usa c56, no c9 — ${bueno.toFixed(2)} publicado ≠ ${malo.toFixed(2)} con c9`,
        Math.abs(pub - bueno) <= 0.5 && Math.abs(pub - malo) > 1, { pub, bueno, malo });
    }
  }
  if (!conPeldano) noMedido('prueba de unidad', 'ningún renglón de mayoreo con factor > 1 en 30 días');

  // ── 2. Disjuntas: ticket + ficha no pasan de la venta de la celda ────────────────────────
  console.log('\n── 2. Las dos piernas no se cuentan dos veces ──');
  if (meta.v && usaMv) {
    const { rows: [d] } = await knex.raw(`
      SELECT COUNT(*) FILTER (WHERE venta_neta_sin_costo < -0.05)::int AS negativas,
             COUNT(*)::int AS celdas,
             COUNT(*) FILTER (WHERE metodo_costo = 'ficha_actual')::int AS ficha
        FROM analytics.v_margin_standard_daily
       WHERE tenant_id = ? AND sale_date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE - 1`, [TENANT]);
    t(`ninguna celda con venta sin costo negativa (${d.celdas} celdas, ${d.ficha} con ficha)`, d.negativas === 0, d);
    t('la vista sí usa la ficha en mayoreo (si fuera 0, el JOIN por almacén+sku se rompió)', d.ficha > 0, d);
  } else {
    noMedido('disjuntas', 'la vista combinada sólo se puede medir con la matview poblada');
  }

  // ── 3. No es espejo ──────────────────────────────────────────────────────────────────────
  console.log('\n── 3. No es espejo ──');
  const { rows: [esp] } = await knex.raw(`
    WITH m AS (SELECT sku, warehouse_code, 1 - SUM(cogs_ficha) / NULLIF(SUM(venta_neta_ficha), 0) mg
                 FROM ${fuente} f GROUP BY 1, 2 HAVING SUM(venta_neta_ficha) > 5000)
    SELECT COUNT(*)::int AS skus FROM (SELECT sku FROM m GROUP BY sku
                                       HAVING COUNT(*) >= 2 AND MAX(mg) - MIN(mg) > 0.01) x`);
  if (top.length) t(`hay SKUs con margen distinto entre sucursales (${esp.skus})`, esp.skus > 0, esp);

  console.log(`\n${ok} ✔ · ${bad} ✗ · ${nm} no medido\n`);
  await knex.destroy();
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  await knex.destroy();
  process.exit(1);
});
