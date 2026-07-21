/* eslint-disable no-console */
/**
 * RS.3 — Rollup mensual EN CAJAS → analytics.sales_boxes_monthly.
 *
 * Deriva de `analytics.sales_daily` (ya normalizada: units en canónico + unit_kind)
 * agregando por producto × almacén × canal × mes y persistiendo la venta en cajas:
 *   · PIEZA → pieces + boxes = pieces / uxc   (uxc = factor_sale, o box_size si factor≤1)
 *   · PESO  → kg;  boxes = NULL (el granel no va en cajas)
 *
 * Todo ocurre en la MISMA DB (destino) → INSERT...SELECT puro, sin fuente externa.
 * Refresco full idempotente: DELETE tenant + INSERT. Barato (grano mensual).
 *
 *   node database/importers/kepler/import-sales-boxes-monthly.js          # dry-run
 *   node database/importers/kepler/import-sales-boxes-monthly.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

// Selecciona el rollup. unit_kind='weight' → kg (no cajas). Resto → piezas + cajas.
// uxc = factor_sale si >1, si no box_size (etiquetas) si >1, si no 1.
const SELECT_SQL = `
  WITH src AS (
    SELECT sd.product_id, sd.warehouse_id, sd.channel,
           to_char(sd.sale_date, 'YYYY-MM') AS ym,
           max(sd.unit_kind) AS kind,
           sum(sd.units)     AS units,
           sum(sd.revenue)   AS revenue,
           sum(sd.tickets)   AS tickets,
           GREATEST(
             CASE WHEN p.factor_sale > 1 THEN p.factor_sale
                  WHEN max(lp.box_size) > 1 THEN max(lp.box_size)
                  ELSE 1 END, 1) AS uxc
      FROM analytics.sales_daily sd
      JOIN catalog.products p ON p.id = sd.product_id AND p.tenant_id = sd.tenant_id
      LEFT JOIN commercial.product_label_prices lp ON lp.product_id = p.id AND lp.tenant_id = p.tenant_id
     WHERE sd.tenant_id = $1
     GROUP BY sd.product_id, sd.warehouse_id, sd.channel, to_char(sd.sale_date, 'YYYY-MM'), p.factor_sale)
  SELECT product_id, warehouse_id, channel, ym, kind,
         CASE WHEN kind = 'weight' THEN NULL ELSE round(units, 3) END        AS pieces,
         CASE WHEN kind = 'weight' THEN round(units, 3) ELSE NULL END         AS kg,
         CASE WHEN kind = 'weight' THEN NULL ELSE round(units / uxc, 3) END   AS boxes,
         uxc, round(revenue, 2) AS revenue, tickets
    FROM src`;

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Rollup cajas → analytics.sales_boxes_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const preview = (await db.query(
      `SELECT count(*) filas,
              count(*) FILTER (WHERE kind='weight') peso,
              count(*) FILTER (WHERE kind IS DISTINCT FROM 'weight') pieza,
              round(sum(revenue)) revenue
         FROM (${SELECT_SQL}) t`, [M])).rows[0];
    console.log(`  a generar: ${preview.filas} filas (pieza ${preview.pieza} · peso ${preview.peso}) · revenue $${preview.revenue}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`DELETE FROM analytics.sales_boxes_monthly WHERE tenant_id = $1`, [M]);
    const ins = await db.query(
      `INSERT INTO analytics.sales_boxes_monthly
         (id, tenant_id, product_id, warehouse_id, channel, year_month, unit_kind,
          pieces, kg, boxes, uxc, revenue, tickets, updated_at)
       SELECT gen_random_uuid(), $1, product_id, warehouse_id, channel, ym, kind,
              pieces, kg, boxes, uxc, revenue, tickets, now()
         FROM (${SELECT_SQL}) t`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${ins.rowCount} filas en analytics.sales_boxes_monthly.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
