/* eslint-disable no-console */
/**
 * `[RD.103.0]` CANDADO: el subtotal de una ruta VECINAL es SIN impuestos, como el de Ruta Directa.
 *
 * ── Lo que esto impide ───────────────────────────────────────────────────────────────────
 * El subtotal es la base de la comisión. Hasta `20261104103527` la rama `kepler_vecinal` de
 * `analytics.v_rd_route_daily` publicaba el importe de la línea de Kepler (`kdm2.c13`), que trae
 * IVA e IEPS: medido en prod Q14–Q21, entre +9.3 % y +12.7 % arriba del neto que el propio
 * documento declara. Con «la comisión sigue al chofer», 2V001 cobraría sobre ese monto.
 *
 * ── El árbitro ──────────────────────────────────────────────────────────────────────────
 * Independiente de la vista: el neto del DOCUMENTO de Kepler (`v_kepler_vecinal_sales_docs.neto`,
 * de `kdm1`). Por ruta, en los últimos 28 días cerrados:
 *   1. |subtotal / neto_documento − 1| ≤ 1.5 %  (lo que queda: descuento de documento y SKUs sin
 *      tasa, declarados como `derivado_tasa_kepler_incompleto`).
 *   2. La venta sigue siendo el total CON impuestos: |venta / (neto + iva + ieps) − 1| ≤ 1.5 %.
 *   3. Un día `derivado_tasa_kepler` (completo) no tiene ninguna línea sin tasa.
 *
 * Prueba negativa hecha (2026-11-04): contra prod ANTES de la migración, el bloque 1 sale rojo en
 * las 8 rutas (+9 a +13 %).
 *
 * Sólo lectura. Sin vecinales en el destino: NO MEDIDO, no verde.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-rd-vecinal-subtotal-neto.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  ⓘ NO MEDIDO · ${label} — ${motivo}`); };
const TOL = 0.015;

(async () => {
  const db = new Client({ connectionString: URL, statement_timeout: 300000 });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');
  console.log(`\n=== [RD.103.0] subtotal vecinal sin impuestos · ${URL.replace(/:\/\/[^@]*@/, '://***@')} ===`);

  const faltan = (await db.query(`SELECT to_regclass('analytics.v_kepler_vecinal_sales_docs') d,
                                         to_regclass('analytics.v_rd_route_daily') v`)).rows[0];
  if (!faltan.d || !faltan.v) {
    noMedido('la unidad vecinal', 'el destino no tiene las vistas de vecinal o de venta por ruta');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`); await db.end(); process.exit(0);
  }

  const { rows } = await db.query(`
    WITH ventana AS (SELECT current_date - 29 AS desde, current_date - 2 AS hasta),
    vista AS (
      SELECT route_code ruta, sum(subtotal) subtotal, sum(venta) venta,
             count(*) FILTER (WHERE subtotal_origen = 'derivado_tasa_kepler_incompleto') dias_incompletos,
             count(*) dias
        FROM analytics.v_rd_route_daily, ventana
       WHERE source = 'kepler_vecinal' AND business_date BETWEEN desde AND hasta GROUP BY 1),
    doc AS (
      SELECT replace(route_code, 'WIN-', '') ruta, sum(neto) neto, sum(neto + impuesto + ieps) bruto
        FROM analytics.v_kepler_vecinal_sales_docs, ventana
       WHERE business_date BETWEEN desde AND hasta GROUP BY 1)
    SELECT v.ruta, v.subtotal::float8 subtotal, v.venta::float8 venta, d.neto::float8 neto,
           d.bruto::float8 bruto, v.dias_incompletos, v.dias
      FROM vista v JOIN doc d USING (ruta) WHERE d.neto > 0 ORDER BY 1`);

  if (!rows.length) {
    noMedido('la unidad vecinal', 'no hay venta vecinal en los últimos 28 días cerrados del destino');
    console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`); await db.end(); process.exit(0);
  }

  console.log('\n— 1. el subtotal es el neto del documento (sin IVA ni IEPS)');
  for (const r of rows) {
    const d = r.subtotal / r.neto - 1;
    check(`${r.ruta}: subtotal ${r.subtotal.toFixed(0)} contra neto ${r.neto.toFixed(0)} (${(100 * d).toFixed(2)} %)`,
      Math.abs(d) <= TOL, Math.abs(d) > 0.05 ? 'parece el total CON impuestos: ¿se revirtió 20261104103527?' : '');
  }

  console.log('\n— 2. la venta sigue siendo el total con impuestos');
  for (const r of rows) {
    const d = r.venta / r.bruto - 1;
    check(`${r.ruta}: venta ${r.venta.toFixed(0)} contra neto+IVA+IEPS ${r.bruto.toFixed(0)} (${(100 * d).toFixed(2)} %)`,
      Math.abs(d) <= TOL);
  }

  console.log('\n— 3. un día «completo» no tiene líneas sin tasa');
  const { rows: [x] } = await db.query(`
    WITH tasa AS (SELECT DISTINCT btrim(c1) articulo FROM kepler_ods.kdii),
    dias AS (
      SELECT sl.source_branch ruta, sl.business_date, bool_and(t.articulo IS NOT NULL) completo
        FROM analytics.v_route_sales_lines sl LEFT JOIN tasa t ON t.articulo = btrim(sl.sku)
       WHERE sl.source = 'kepler_vecinal' AND sl.business_date BETWEEN current_date - 29 AND current_date - 2
       GROUP BY 1, 2)
    SELECT count(*) FILTER (WHERE NOT d.completo AND v.subtotal_origen = 'derivado_tasa_kepler')::int mienten,
           count(*) FILTER (WHERE NOT d.completo)::int incompletos
      FROM dias d JOIN analytics.v_rd_route_daily v
        ON v.source = 'kepler_vecinal' AND v.route_code = d.ruta AND v.business_date = d.business_date`);
  check(`ningún día con SKU sin tasa se declara completo (${x.incompletos} días incompletos)`, x.mienten === 0,
    `${x.mienten} días se declaran completos y no lo son`);

  console.log(`\n  ${ok} ✔ · ${fail} ✖ · ${nm} ⓘ\n`);
  await db.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
