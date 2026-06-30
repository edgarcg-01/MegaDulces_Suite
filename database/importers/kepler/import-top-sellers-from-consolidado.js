/* eslint-disable no-console */
/**
 * Best-sellers VIVOS de la red → catalog.top_sellers_live (consumido por el
 * portal: home/carrusel/orden por popularidad).
 *
 * Reemplaza la fuente stale (erp.ranking_productos vía FDW, ETL por archivos)
 * por la venta real consolidada de mart.ventas (6 sucursales, 90d).
 *
 * NO toca el MV viejo catalog.products_top_sellers (sigue ahí intacto). El
 * endpoint del portal apunta a esta tabla nueva. READ-ONLY sobre las sucursales
 * (mart.ventas ya es local). TRUNCATE+INSERT (tabla propia, top 1000 por venta).
 *
 *   node database/importers/kepler/import-top-sellers-from-consolidado.js          # dry-run
 *   node database/importers/kepler/import-top-sellers-from-consolidado.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const TOP_N = 1000;
const SRC = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();

  try {
    console.log(`\n=== Best-sellers vivos red (90d) → catalog.top_sellers_live (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // Top N por venta (importe) en 90d.
    const { rows: top } = await src.query(
      `SELECT sku,
              round(sum(cantidad))::numeric AS units_sold,
              round(sum(importe),2)         AS revenue,
              round(sum(cantidad))::numeric AS units_total
         FROM mart.ventas
        WHERE fecha >= current_date - 90 AND sku IS NOT NULL
        GROUP BY sku
        ORDER BY sum(importe) DESC
        LIMIT $1`, [TOP_N]);
    console.log(`Best-sellers calculados: ${top.length}`);

    // Metadata de catálogo por sku.
    const { rows: prods } = await db.query(
      `SELECT id, sku, nombre, brand_id, barcode, category_id, cost_base, image_url
         FROM public.products WHERE tenant_id=$1`, [M]);
    const bySku = new Map(prods.map((p) => [p.sku, p]));

    const finalRows = [];
    let rank = 0, unmatched = 0;
    for (const r of top) {
      const p = bySku.get(r.sku);
      if (!p) { unmatched++; continue; }
      rank++;
      finalRows.push({ ...p, units_sold: r.units_sold, revenue: r.revenue, units_total: r.units_total, sales_rank: rank });
    }
    console.log(`Con match catálogo: ${finalRows.length} (sin match: ${unmatched})`);

    // BULK: INSERT multi-fila en batches (per-fila contra prod remoto era lento).
    const BATCH = 500;
    const PPR = 13; // params por fila (cases_sold va literal 0, no es param)
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`TRUNCATE catalog.top_sellers_live`);
    for (let i = 0; i < finalRows.length; i += BATCH) {
      const chunk = finalRows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((f, ri) => {
        const b = ri * PPR;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},0,$${b+12},$${b+13})`);
        params.push(f.id, M, f.sku, f.nombre, f.brand_id, f.barcode, f.category_id, f.cost_base, f.image_url,
          f.units_sold, f.revenue, f.units_total, f.sales_rank);
      });
      await db.query(
        `INSERT INTO catalog.top_sellers_live
           (id, tenant_id, sku, nombre, brand_id, barcode, category_id, cost_base, image_url,
            units_sold, revenue, cases_sold, units_total, sales_rank)
         VALUES ${vals.join(',')}`, params);
    }

    if (APPLY) {
      await db.query('COMMIT');
      console.log(`\n[APPLY] COMMIT — ${finalRows.length} best-sellers vivos para el portal.`);
    } else {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — nada cambió.');
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
