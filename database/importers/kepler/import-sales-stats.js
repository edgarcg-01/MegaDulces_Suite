/* eslint-disable no-console */
/**
 * KV.2 — Computa analytics.product_sales_stats desde analytics.sales_daily.
 *
 * Todo server-side (un INSERT...SELECT...ON CONFLICT): rolling 30/90/365d por
 * producto + ABC (Pareto por revenue_365d: acum ≤80%=A, ≤95%=B, resto=C) +
 * participación %. NO ship de filas → corre en segundos aunque sea contra prod.
 * Single-DB (lee y escribe DATABASE_URL_NEW).
 *
 *   node database/importers/kepler/import-sales-stats.js          # dry-run (reporta)
 *   node database/importers/kepler/import-sales-stats.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

const SELECT_STATS = `
  WITH base AS (
    SELECT product_id,
           sum(units)   FILTER (WHERE sale_date >= current_date-30)  AS units_30d,
           sum(revenue) FILTER (WHERE sale_date >= current_date-30)  AS revenue_30d,
           sum(units)   FILTER (WHERE sale_date >= current_date-90)  AS units_90d,
           sum(revenue) FILTER (WHERE sale_date >= current_date-90)  AS revenue_90d,
           sum(units)   FILTER (WHERE sale_date >= current_date-365) AS units_365d,
           sum(revenue) FILTER (WHERE sale_date >= current_date-365) AS revenue_365d
      FROM analytics.sales_daily
     WHERE tenant_id = $1
     GROUP BY product_id
  ),
  ranked AS (
    SELECT *,
           coalesce(revenue_365d,0) AS rev,
           sum(coalesce(revenue_365d,0)) OVER () AS total_rev,
           sum(coalesce(revenue_365d,0)) OVER (ORDER BY coalesce(revenue_365d,0) DESC
                                               ROWS UNBOUNDED PRECEDING) AS cum_rev
      FROM base
  )
  SELECT product_id,
         coalesce(units_30d,0)   AS units_30d,   coalesce(revenue_30d,0)  AS revenue_30d,
         coalesce(units_90d,0)   AS units_90d,   coalesce(revenue_90d,0)  AS revenue_90d,
         coalesce(units_365d,0)  AS units_365d,  coalesce(revenue_365d,0) AS revenue_365d,
         CASE WHEN total_rev <= 0 THEN 'C'
              WHEN cum_rev <= 0.80*total_rev THEN 'A'
              WHEN cum_rev <= 0.95*total_rev THEN 'B'
              ELSE 'C' END                       AS abc_class,
         round(100*rev/nullif(total_rev,0), 4)   AS revenue_share_pct
    FROM ranked`;

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== product_sales_stats desde sales_daily (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const { rows: dist } = await db.query(
      `SELECT abc_class, count(*) productos, round(sum(revenue_365d)) revenue
         FROM (${SELECT_STATS}) s GROUP BY abc_class ORDER BY abc_class`, [M]);
    console.table(dist);

    if (!APPLY) {
      console.log('\n[DRY-RUN] nada cambió.');
      return;
    }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const up = await db.query(
      `INSERT INTO analytics.product_sales_stats
         (tenant_id, product_id, units_30d, revenue_30d, units_90d, revenue_90d,
          units_365d, revenue_365d, abc_class, revenue_share_pct, computed_at)
       SELECT $1, product_id, units_30d, revenue_30d, units_90d, revenue_90d,
              units_365d, revenue_365d, abc_class, revenue_share_pct, now()
         FROM (${SELECT_STATS}) s
       ON CONFLICT (tenant_id, product_id) DO UPDATE SET
         units_30d=EXCLUDED.units_30d, revenue_30d=EXCLUDED.revenue_30d,
         units_90d=EXCLUDED.units_90d, revenue_90d=EXCLUDED.revenue_90d,
         units_365d=EXCLUDED.units_365d, revenue_365d=EXCLUDED.revenue_365d,
         abc_class=EXCLUDED.abc_class, revenue_share_pct=EXCLUDED.revenue_share_pct,
         computed_at=now()`, [M]);
    // Limpia productos que ya no tienen ventas en la ventana (salieron del fact).
    const del = await db.query(
      `DELETE FROM analytics.product_sales_stats p
        WHERE tenant_id=$1 AND NOT EXISTS (
          SELECT 1 FROM analytics.sales_daily s WHERE s.tenant_id=$1 AND s.product_id=p.product_id)`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} upserted, ${del.rowCount} purgados (sin venta).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
