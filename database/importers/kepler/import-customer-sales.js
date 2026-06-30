/* eslint-disable no-console */
/**
 * KV.3 — Historial de compra por cliente → analytics.customer_product_sales.
 *
 * Fuente: mart.ventas_enriched (consolidado). Agrega por (erp_code, sku) en 90/180d,
 * excluye CONTADO (mostrador anónimo, erp_customer_ref NULL). erp_code normalizado
 * (numéricos a 5 dígitos). Refresco full (TRUNCATE+INSERT). Mapea sku→product_id.
 *
 *   node database/importers/kepler/import-customer-sales.js          # dry-run
 *   node database/importers/kepler/import-customer-sales.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@localhost:5433/kepler_consolidado';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 2000;

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  try {
    console.log(`\n=== Historial por cliente → analytics.customer_product_sales (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const prods = (await db.query(
      `SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuTo = new Map(prods.map((p) => [p.sku, p.id]));

    const { rows: agg } = await src.query(
      `SELECT CASE WHEN erp_customer_ref ~ '^[0-9]+$' THEN lpad(erp_customer_ref,5,'0') ELSE erp_customer_ref END AS erp_code,
              sku,
              COALESCE(sum(cantidad) FILTER (WHERE fecha >= current_date-90),0)::numeric  AS units_90d,
              COALESCE(round(sum(importe) FILTER (WHERE fecha >= current_date-90),2),0)::numeric AS revenue_90d,
              COALESCE(sum(cantidad) FILTER (WHERE fecha >= current_date-180),0)::numeric AS units_180d,
              COALESCE(round(sum(importe) FILTER (WHERE fecha >= current_date-180),2),0)::numeric AS revenue_180d,
              max(fecha) AS last_purchase_date
         FROM mart.ventas_enriched
        WHERE erp_customer_ref IS NOT NULL AND fecha >= current_date-180
        GROUP BY 1, sku`);
    console.log(`  origen agregado: ${agg.length} (cliente×producto)`);

    const rows = []; let noSku = 0;
    for (const r of agg) {
      const pid = skuTo.get(String(r.sku).trim());
      if (!pid) { noSku++; continue; }
      rows.push([r.erp_code, pid, r.units_90d, r.revenue_90d, r.units_180d, r.revenue_180d, r.last_purchase_date]);
    }
    console.log(`  a cargar: ${rows.length} (sin sku en catálogo: ${noSku})`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`TRUNCATE analytics.customer_product_sales`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => {
        const b = ri * 8;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},now())`);
        params.push(M, row[0], row[1], row[2], row[3], row[4], row[5], row[6]);
      });
      await db.query(
        `INSERT INTO analytics.customer_product_sales
           (tenant_id, erp_code, product_id, units_90d, revenue_90d, units_180d, revenue_180d, last_purchase_date, computed_at)
         VALUES ${vals.join(',')}`, params);
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${rows.length} filas cliente×producto.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
