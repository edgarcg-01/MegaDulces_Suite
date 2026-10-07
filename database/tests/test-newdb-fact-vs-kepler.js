/* eslint-disable no-console */
/**
 * CANDADO — existencia y ventas del fact contra Kepler, con PRUEBA DE UNIDAD explícita.
 *
 * Hermano de `test-newdb-cost-ladder.js`. Aquel nació de un bug real (el costo de caja se
 * reconstruía y mezclaba peldaños); éste nació de auditar las otras dos magnitudes con el mismo
 * protocolo (docs/ERP_KEPLER.md §5 regla 0) para dejar constancia de que estaban BIEN — y que si
 * algún día dejan de estarlo, se sepa el mismo día.
 *
 * Lo que vigila, y por qué no basta con "cuadra el total":
 *   · la MEDIANA de la razón por SKU (un total puede cuadrar compensando errores opuestos);
 *   · que la razón NO se pegue a `bf` ni a `1/bf` — ésa es la firma del error de unidad que ya
 *     nos costó dos veces (ADR-051 y RA-PRO.46).
 *
 * Trampas de Kepler que este test ya trae resueltas (ver §2.2):
 *   · existencia = kdil.c4 + c8 − c9   (c9 son SALIDAS, no la existencia);
 *   · venta = doctypes U-D-8/10/12 (naturaleza D; K.3 — antes sólo U-D-10);
 *     U-A-10 es "Entrada por Devolución";
 *   · el SKU de kdm2 es c8, no c3;
 *   · los folios se RECICLAN → se usa la fecha propia de la línea (c32), nunca sólo la del header.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-fact-vs-kepler.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const SUCS = ['03', '01', '05'];

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log('\n=== fact vs Kepler · existencia y ventas (prueba de unidad) ===\n');

  const ods = (await c.query(`SELECT to_regclass('kepler_ods.kdil') a, to_regclass('kepler_ods.kdm2') b`)).rows[0];
  if (!ods.a || !ods.b) {
    console.log('  ⓘ sin kepler_ods en este destino — se omite todo (entorno local sin feeds)\n');
    await c.end(); process.exit(2);
  }

  // ── EXISTENCIA ────────────────────────────────────────────────────────────────────────────
  console.log('EXISTENCIA (kdil: inicial c4 + entradas c8 − salidas c9)');
  for (const suc of SUCS) {
    const r = (await c.query(`
      WITH k AS (
        SELECT btrim(c3::text) sku, sum(GREATEST(c4::numeric + c8::numeric - c9::numeric, 0)) qty
          FROM kepler_ods.kdil
         WHERE sucursal=$2 AND c1::text=$2 AND btrim(coalesce(c3::text,'')) <> ''
         GROUP BY 1),
      n AS (
        SELECT p.sku, sum(s.quantity) qty, max(COALESCE(bf.box_factor,1)) bf
          FROM commercial.stock s
          JOIN catalog.products p ON p.id = s.product_id
          JOIN commercial.warehouses w ON w.id = s.warehouse_id
          LEFT JOIN analytics.v_product_box_factor bf ON bf.tenant_id = s.tenant_id AND bf.product_id = s.product_id
         WHERE s.tenant_id=$1 AND COALESCE(w.kepler_code, w.code)=$2
         GROUP BY 1),
      j AS (SELECT k.sku, k.qty kq, n.qty nq, n.bf FROM k JOIN n ON n.sku = k.sku WHERE k.qty > 0 AND n.qty > 0)
      SELECT count(*)::int n,
             count(*) FILTER (WHERE abs(nq - kq) <= 0.01 * kq)::int igual,
             count(*) FILTER (WHERE bf > 1 AND abs(nq/NULLIF(kq,0) - bf) <= 0.1*bf)::int ubf,
             count(*) FILTER (WHERE bf > 1 AND abs(nq/NULLIF(kq,0) - 1.0/bf) <= 0.1/bf)::int uinv,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY nq/NULLIF(kq,0))::numeric, 4) med
        FROM j`, [T, suc])).rows[0];
    if (!r.n) { console.log(`  ⓘ suc ${suc} sin universo comparable — se omite`); continue; }
    const pct = (100 * r.igual / r.n).toFixed(1);
    check(`suc ${suc}: mediana de la razón ≈ 1 (${r.med})`, Math.abs(Number(r.med) - 1) <= 0.02, `n=${r.n}`);
    check(`suc ${suc}: la mayoría cuadra al 1% (${pct}%)`, r.igual > r.n * 0.9, `${r.igual}/${r.n}`);
    check(`suc ${suc}: sin desfase de unidad (bf / 1÷bf)`, r.ubf + r.uinv < r.n * 0.01, `bf=${r.ubf} inv=${r.uinv} de ${r.n}`);
  }

  // ── VENTAS ────────────────────────────────────────────────────────────────────────────────
  // ⭐ K.3 (2026-09-08): el universo pasó de `c4='10'` a 8/10/12, porque el fact cambió.
  // `mart.ventas` dejó de filtrar sólo el ticket, así que comparar nuestro lado (que ya trae
  // los tres doctypes) contra un Kepler recortado a U-D-10 mide DOS POBLACIONES. El síntoma
  // fue nítido y vale como registro: las MEDIANAS por SKU siguieron en 1.0000 exactas — o sea
  // ningún SKU se distorsionó — y lo único que se movió fue el TOTAL, y sólo donde hay
  // telemarketing. Medido en prod, 90 d, (U-D-8 + U-D-12) / U-D-10 por sucursal:
  //     01  1.7970   ($10,134,707 de U-D-8)      04  1.0074
  //     06  2.1292   ($4,445,475 de U-D-8)       05  1.0145
  //     02  1.0021 · 03  1.0020                  (U-D-8 = 0 en 02/03/04/05)
  // Es decir: U-D-8 sólo existe en PH (01) y Canindo (06). El total de la 01 saltó a 1.86 y el
  // candado se puso rojo — hizo exactamente su trabajo.
  // ⚠️ SUCS no incluye la 06, que es la de mayor salto relativo (2.13×). Queda anotado.
  console.log('\nVENTAS (kdm2 U-D-8/10/12 · SKU=c8 · fecha propia c32)');
  for (const suc of SUCS) {
    const r = (await c.query(`
      WITH k AS (
        SELECT btrim(c8::text) sku, sum(c9::numeric) u, sum(c13::numeric) i
          FROM kepler_ods.kdm2
         WHERE sucursal=$2 AND c1::text=$2 AND c2::text='U' AND c3::text='D'
           AND btrim(c4::text) IN ('8','10','12')
           AND c32::date >= current_date - 30 AND c9::numeric > 0
         GROUP BY 1),
      n AS (
        SELECT p.sku, sum(sd.units) u, sum(sd.revenue) i, max(COALESCE(bf.box_factor,1)) bf
          FROM analytics.sales_daily sd
          JOIN catalog.products p ON p.id = sd.product_id
          JOIN commercial.warehouses w ON w.id = sd.warehouse_id
          LEFT JOIN analytics.v_product_box_factor bf ON bf.tenant_id = sd.tenant_id AND bf.product_id = sd.product_id
         WHERE sd.tenant_id=$1 AND COALESCE(w.kepler_code, w.code)=$2 AND sd.sale_date >= current_date - 30
         GROUP BY 1),
      j AS (SELECT k.u ku, k.i ki, n.u nu, n.i ni, n.bf FROM k JOIN n ON n.sku = k.sku WHERE k.i > 0 AND n.i > 0)
      SELECT count(*)::int n,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ni/NULLIF(ki,0))::numeric, 4) med_i,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY nu/NULLIF(ku,0))::numeric, 4) med_u,
             count(*) FILTER (WHERE bf > 1 AND abs(nu/NULLIF(ku,0) - bf) <= 0.1*bf)::int ubf,
             count(*) FILTER (WHERE bf > 1 AND abs(nu/NULLIF(ku,0) - 1.0/bf) <= 0.1/bf)::int uinv,
             round((sum(ni)/NULLIF(sum(ki),0))::numeric, 4) tot
        FROM j`, [T, suc])).rows[0];
    if (!r.n) { console.log(`  ⓘ suc ${suc} sin ventas comparables — se omite`); continue; }
    check(`suc ${suc}: importe, mediana ≈ 1 (${r.med_i})`, Math.abs(Number(r.med_i) - 1) <= 0.03, `n=${r.n}`);
    check(`suc ${suc}: unidades, mediana ≈ 1 (${r.med_u})`, Math.abs(Number(r.med_u) - 1) <= 0.03, `n=${r.n}`);
    check(`suc ${suc}: el total no se desvía >8% (${r.tot})`, Math.abs(Number(r.tot) - 1) <= 0.08);
    check(`suc ${suc}: sin desfase de unidad (bf / 1÷bf)`, r.ubf + r.uinv < r.n * 0.01, `bf=${r.ubf} inv=${r.uinv} de ${r.n}`);
  }

  await c.end();
  console.log(`\n=== ${ok} OK · ${fail} fallas ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
