/* eslint-disable no-console */
/**
 * RA.3 — Reorden COMPUTADO por demanda → commercial.reorder_policy (source='computed').
 *
 * Rellena los huecos que Kepler no configura (~82% del catálogo; CEDIS = 100%).
 * Transform 100% dentro de la plataforma (no toca Kepler): lee analytics.inventory_health
 * (avg_daily_units por producto×almacén, poblado por import-inventory-health.js) + lead time
 * del proveedor + clase ABC para el colchón.
 *
 *   reorder_point = ceil(avg_daily × lead) + safety
 *   min_stock     = safety = ceil(avg_daily × safety_days)   (A=7 / B=5 / C=3 / s.c=5)
 *   max_stock     = reorder_point + ceil(avg_daily × cycle_days)   (cycle default 14)
 *
 * NUNCA pisa source='kepler' ni 'manual' (ON CONFLICT ... WHERE source='computed').
 * Sólo productos con demanda (avg_daily_units > 0). Correr DESPUÉS de import-reorder-policy
 * (kepler manda) y de import-inventory-health (avg_daily fresco).
 *
 *   node database/importers/kepler/import-computed-reorder.js          # dry-run
 *   node database/importers/kepler/import-computed-reorder.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const LEAD_DEFAULT = Number(process.env.REORDER_LEAD_DEFAULT || 7);
const SAFETY_DAYS = Number(process.env.REORDER_SAFETY_DAYS || 5);
const CYCLE_DAYS = Number(process.env.REORDER_CYCLE_DAYS || 14);

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Reorden computado por demanda → commercial.reorder_policy (${APPLY ? 'APPLY' : 'DRY-RUN'}; lead=${LEAD_DEFAULT} safety=${SAFETY_DAYS}d cycle=${CYCLE_DAYS}d) ===\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    const res = await db.query(`
      WITH base AS (
        SELECT ih.warehouse_id, ih.product_id, ih.avg_daily_units AS adu,
               COALESCE(s.lead_time_days, $2) AS lead,
               CASE abc.abc_class WHEN 'A' THEN 7 WHEN 'B' THEN 5 WHEN 'C' THEN 3 ELSE $3 END AS safety_days
          FROM analytics.inventory_health ih
          JOIN catalog.products p ON p.tenant_id=$1 AND p.id=ih.product_id
          LEFT JOIN catalog.suppliers s ON s.tenant_id=$1 AND s.id=p.supplier_id
          LEFT JOIN commercial.abc_classification abc
                 ON abc.tenant_id=$1 AND abc.warehouse_id=ih.warehouse_id AND abc.product_id=ih.product_id
         WHERE ih.tenant_id=$1 AND ih.avg_daily_units > 0
      ), calc AS (
        SELECT warehouse_id, product_id, lead,
               ceil(adu * safety_days)::numeric AS safety,
               ceil(adu * lead)::numeric        AS lead_demand,
               ceil(adu * $4)::numeric          AS cycle_demand
          FROM base
      )
      INSERT INTO commercial.reorder_policy
        (id, tenant_id, warehouse_id, product_id, min_stock, reorder_point, max_stock, source, lead_time_days, safety_stock, computed_at, updated_at)
      SELECT gen_random_uuid(), $1, warehouse_id, product_id,
             safety, lead_demand + safety, lead_demand + safety + cycle_demand,
             'computed', lead, safety, now(), now()
        FROM calc
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
        SET min_stock=EXCLUDED.min_stock, reorder_point=EXCLUDED.reorder_point, max_stock=EXCLUDED.max_stock,
            lead_time_days=EXCLUDED.lead_time_days, safety_stock=EXCLUDED.safety_stock, computed_at=now(), updated_at=now()
        WHERE commercial.reorder_policy.source = 'computed'`,
      [M, LEAD_DEFAULT, SAFETY_DAYS, CYCLE_DAYS]);

    console.log(`  filas computadas (insert+update de source='computed'): ${res.rowCount}`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    await db.query('COMMIT');
    console.log('\n[APPLY] COMMIT.');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
