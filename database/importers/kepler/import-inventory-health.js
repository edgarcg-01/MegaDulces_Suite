/* eslint-disable no-console */
/**
 * KV.5 — Computa analytics.inventory_health desde commercial.stock × sales_daily.
 *
 * Server-side (prod-interno, sin ship de filas). days_cover = on_hand / venta diaria
 * promedio (90d). status:
 *   agotado    on_hand<=0
 *   nuevo      sin venta 90d pero producto creado < 30d
 *   muerto     sin venta 90d y on_hand>0 (no nuevo)
 *   critico    days_cover < 7
 *   sano       7..60
 *   sobrestock > 60
 *
 *   node database/importers/kepler/import-inventory-health.js          # dry-run
 *   node database/importers/kepler/import-inventory-health.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

const SELECT_HEALTH = `
  WITH vel AS (
    SELECT product_id, warehouse_id, sum(units) AS units_90d
      FROM analytics.sales_daily
     WHERE tenant_id = $1 AND sale_date >= current_date - 90
     GROUP BY product_id, warehouse_id
  )
  SELECT s.product_id, s.warehouse_id,
         s.quantity AS on_hand,
         round(COALESCE(v.units_90d,0) / 90.0, 4) AS avg_daily_units,
         CASE WHEN COALESCE(v.units_90d,0) > 0
              THEN round(s.quantity / (v.units_90d / 90.0), 1) END AS days_cover,
         CASE
           WHEN s.quantity <= 0 THEN 'agotado'
           WHEN COALESCE(v.units_90d,0) = 0 THEN
             CASE WHEN p.created_at >= current_date - 30 THEN 'nuevo' ELSE 'muerto' END
           WHEN s.quantity / (v.units_90d / 90.0) < 7  THEN 'critico'
           WHEN s.quantity / (v.units_90d / 90.0) <= 60 THEN 'sano'
           ELSE 'sobrestock'
         END AS status
    FROM commercial.stock s
    JOIN catalog.products p ON p.id = s.product_id AND p.tenant_id = $1
    JOIN commercial.warehouses w ON w.id = s.warehouse_id AND w.tenant_id = $1 AND w.deleted_at IS NULL
    LEFT JOIN vel v ON v.product_id = s.product_id AND v.warehouse_id = s.warehouse_id
   WHERE s.tenant_id = $1`;

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== inventory_health desde stock × sales_daily (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const { rows: dist } = await db.query(
      `SELECT status, count(*) FROM (${SELECT_HEALTH}) h GROUP BY status ORDER BY count(*) DESC`, [M]);
    console.table(dist);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const up = await db.query(
      `INSERT INTO analytics.inventory_health
         (tenant_id, product_id, warehouse_id, on_hand, avg_daily_units, days_cover, status, computed_at)
       SELECT $1, product_id, warehouse_id, on_hand, avg_daily_units, days_cover, status, now()
         FROM (${SELECT_HEALTH}) h
       ON CONFLICT (tenant_id, product_id, warehouse_id) DO UPDATE SET
         on_hand=EXCLUDED.on_hand, avg_daily_units=EXCLUDED.avg_daily_units,
         days_cover=EXCLUDED.days_cover, status=EXCLUDED.status, computed_at=now()`, [M]);
    // Purga filas cuyo (product,warehouse) ya no está en stock, o cuyo almacén
    // quedó soft-deleted (p.ej. warehouses efímeros de tests).
    const del = await db.query(
      `DELETE FROM analytics.inventory_health h
        WHERE tenant_id=$1 AND (
          NOT EXISTS (
            SELECT 1 FROM commercial.stock s
             WHERE s.tenant_id=$1 AND s.product_id=h.product_id AND s.warehouse_id=h.warehouse_id)
          OR EXISTS (
            SELECT 1 FROM commercial.warehouses w
             WHERE w.id=h.warehouse_id AND w.deleted_at IS NOT NULL))`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} upserted, ${del.rowCount} purgados.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
