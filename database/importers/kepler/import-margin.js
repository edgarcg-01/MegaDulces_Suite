/* eslint-disable no-console */
/**
 * KV.4 — Markup % por producto → catalog.products.markup_pct, MODO BULK.
 *
 * Fuente: md.kdpv_prod_util (c1=sku, c3=nivel de volumen, c6=markup% sobre costo)
 * de una sucursal Kepler (los markups se fijan central, una sucursal es
 * representativa). markup_pct = promedio de c6 sobre los tiers/presentaciones del
 * SKU. Lo consume import-sales-fact.js (cost=revenue/(1+markup/100)) y Thot.
 *
 *   node database/importers/kepler/import-margin.js          # dry-run
 *   node database/importers/kepler/import-margin.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.MARGIN_BRANCH_URL || 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 2000;

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  try {
    console.log(`\n=== Markup % → catalog.products.markup_pct (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // Markup promedio por SKU (todos los tiers/presentaciones). c6 numérico válido.
    const { rows: mk } = await src.query(
      `SELECT c1 AS sku, round(avg(c6::numeric), 4) AS markup
         FROM md.kdpv_prod_util
        WHERE c6 IS NOT NULL AND btrim(coalesce(c1,'')) <> ''
        GROUP BY c1`);
    console.log(`  source sucursal: ${mk.length} SKUs con markup`);

    const prods = (await db.query(
      `SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuTo = new Map(prods.map((p) => [p.sku, p.id]));

    const rows = []; let noMatch = 0;
    for (const r of mk) {
      const id = skuTo.get(r.sku);
      if (!id) { noMatch++; continue; }
      rows.push([id, r.markup]);
    }
    const vals = rows.map((r) => Number(r[1]));
    const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    console.log(`  a actualizar: ${rows.length} (sin match catálogo: ${noMatch}) · markup promedio: ${avg.toFixed(1)}%`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_mk (id uuid, markup numeric) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const v = [], params = [];
      chunk.forEach((row, ri) => { v.push(`($${ri*2+1},$${ri*2+2})`); params.push(row[0], row[1]); });
      await db.query(`INSERT INTO stg_mk (id, markup) VALUES ${v.join(',')}`, params);
    }
    const up = await db.query(
      `UPDATE catalog.products p SET markup_pct=s.markup, updated_at=now()
         FROM stg_mk s WHERE p.id=s.id AND p.tenant_id=$1`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} productos con markup_pct.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
