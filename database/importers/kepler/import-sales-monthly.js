/* eslint-disable no-console */
/**
 * HVT.1 — Rollup MENSUAL de venta real: analytics.sales_daily → analytics.sales_monthly.
 *
 * Agregación server-side (no jala filas a JS): GROUP BY producto × almacén × canal × mes.
 * GUARD de fechas: solo `sale_date BETWEEN 2024-01-01 y hoy` — descarta la basura
 * (filas 2000/2014/2020) y los futuros (2026-12-06 de wincaja_ruta) sin borrar sales_daily.
 *
 * Idempotente: CREATE TABLE IF NOT EXISTS + staging → UPSERT (IS DISTINCT, sin churn) +
 * DELETE de meses ya no presentes en la ventana. Corre directo contra la DB nueva
 * (Railway o local), sin Kepler.
 *
 *   node database/importers/kepler/import-sales-monthly.js            # dry-run (cuenta)
 *   node database/importers/kepler/import-sales-monthly.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const FLOOR = '2024-01-01'; // piso de fechas válidas (mata basura histórica)

(async () => {
  const d = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await d.connect();
  try {
    console.log(`\n=== ROLLUP MENSUAL → analytics.sales_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    await d.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await d.query(`
      CREATE TABLE IF NOT EXISTS analytics.sales_monthly (
        tenant_id uuid NOT NULL, product_id uuid NOT NULL, warehouse_id uuid NOT NULL,
        channel text NOT NULL, month date NOT NULL,
        units numeric NOT NULL DEFAULT 0, revenue numeric NOT NULL DEFAULT 0,
        cost numeric, tickets integer NOT NULL DEFAULT 0, unit_kind text,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, product_id, warehouse_id, channel, month))`);
    await d.query(`CREATE INDEX IF NOT EXISTS idx_sales_monthly_prod_month ON analytics.sales_monthly (tenant_id, product_id, month)`);
    await d.query(`CREATE INDEX IF NOT EXISTS idx_sales_monthly_month ON analytics.sales_monthly (tenant_id, month)`);
    await d.query(`GRANT SELECT ON analytics.sales_monthly TO app_runtime`).catch(() => {});

    const AGG = `
      SELECT tenant_id, product_id, warehouse_id, channel,
             date_trunc('month', sale_date)::date AS month,
             sum(units)::numeric units, sum(revenue)::numeric revenue,
             sum(cost)::numeric cost, sum(tickets)::int tickets, max(unit_kind) unit_kind
        FROM analytics.sales_daily
       WHERE tenant_id = $1 AND sale_date >= DATE '${FLOOR}' AND sale_date <= current_date
       GROUP BY tenant_id, product_id, warehouse_id, channel, date_trunc('month', sale_date)`;

    const pre = (await d.query(`SELECT count(*)::int filas, min(month) mn, max(month) mx FROM (${AGG}) x`, [M])).rows[0];
    console.log(`  origen (sales_daily agregado): ${pre.filas} filas mensuales · ${String(pre.mn).slice(0, 7)} → ${String(pre.mx).slice(0, 7)}`);

    if (!APPLY) { console.log('\n[DRY-RUN] usar --apply.'); return; }

    await d.query('BEGIN');
    await d.query(`CREATE TEMP TABLE stg_sm ON COMMIT DROP AS ${AGG}`, [M]);
    const up = await d.query(`
      INSERT INTO analytics.sales_monthly AS t
        (tenant_id, product_id, warehouse_id, channel, month, units, revenue, cost, tickets, unit_kind, updated_at)
      SELECT tenant_id, product_id, warehouse_id, channel, month, units, revenue, cost, tickets, unit_kind, now() FROM stg_sm
      ON CONFLICT (tenant_id, product_id, warehouse_id, channel, month) DO UPDATE
        SET units=EXCLUDED.units, revenue=EXCLUDED.revenue, cost=EXCLUDED.cost,
            tickets=EXCLUDED.tickets, unit_kind=EXCLUDED.unit_kind, updated_at=now()
      WHERE (t.units, t.revenue, t.cost, t.tickets, t.unit_kind)
            IS DISTINCT FROM (EXCLUDED.units, EXCLUDED.revenue, EXCLUDED.cost, EXCLUDED.tickets, EXCLUDED.unit_kind)`);
    const del = await d.query(`
      DELETE FROM analytics.sales_monthly t
       WHERE t.tenant_id = $1 AND t.month >= DATE '${FLOOR}'
         AND NOT EXISTS (SELECT 1 FROM stg_sm s
                          WHERE s.product_id=t.product_id AND s.warehouse_id=t.warehouse_id
                            AND s.channel=t.channel AND s.month=t.month)`, [M]);
    await d.query('COMMIT');
    console.log(`\n[APPLY] ${up.rowCount} escritas/actualizadas · ${del.rowCount} borradas (fuera de ventana).`);
  } catch (e) {
    await d.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await d.end();
  }
})();
