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
// RA-PRO.38 — uxc = factor de caja del RESOLVEDOR CANÓNICO `analytics.v_product_box_factor`
// (override > c84 Kepler > etiquetera > factor_sale, con guarda anti-pallet). Misma verdad
// que compras y que el sell-out on-the-fly → cajas consistentes en todos lados.
const SELECT_SQL = `
  WITH src AS (
    SELECT sd.product_id, sd.warehouse_id, sd.channel,
           to_char(sd.sale_date, 'YYYY-MM') AS ym,
           max(sd.unit_kind) AS kind,
           sum(sd.units)     AS units,
           sum(sd.revenue)   AS revenue,
           sum(sd.tickets)   AS tickets,
           GREATEST(COALESCE(max(vbf.box_factor), 1), 1) AS uxc
      FROM analytics.sales_daily sd
      LEFT JOIN analytics.v_product_box_factor vbf ON vbf.product_id = sd.product_id AND vbf.tenant_id = sd.tenant_id
     WHERE sd.tenant_id = $1
     GROUP BY sd.product_id, sd.warehouse_id, sd.channel, to_char(sd.sale_date, 'YYYY-MM'))
  SELECT product_id, warehouse_id, channel, ym, kind,
         CASE WHEN kind = 'weight' THEN NULL ELSE round(units, 3) END        AS pieces,
         CASE WHEN kind = 'weight' THEN round(units, 3) ELSE NULL END         AS kg,
         CASE WHEN kind = 'weight' THEN NULL ELSE round(units / uxc, 3) END   AS boxes,
         uxc, round(revenue, 2) AS revenue, tickets
    FROM src`;

(async () => {
  const remote = !/@(localhost|127\.0\.0\.1|192\.168\.)/.test(DST);
  const db = new Client({
    connectionString: DST,
    ssl: remote ? { rejectUnauthorized: false } : false,
    keepAlive: true,
    statement_timeout: 0,
  });
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
    // Refresco IDEMPOTENTE sin churn: staging TEMP → UPSERT solo-cambios → DELETE solo lo
    // que salió del origen. Antes: DELETE-all+INSERT reescribía toda la tabla cada nightly.
    await db.query(
      `CREATE TEMP TABLE stg_sbm ON COMMIT DROP AS
       SELECT $1::uuid AS tenant_id, product_id, warehouse_id, channel, ym AS year_month, kind AS unit_kind,
              pieces, kg, boxes, uxc, revenue, tickets
         FROM (${SELECT_SQL}) t`, [M]);
    const up = await db.query(
      `INSERT INTO analytics.sales_boxes_monthly AS t
         (id, tenant_id, product_id, warehouse_id, channel, year_month, unit_kind,
          pieces, kg, boxes, uxc, revenue, tickets, updated_at)
       SELECT gen_random_uuid(), tenant_id, product_id, warehouse_id, channel, year_month, unit_kind,
              pieces, kg, boxes, uxc, revenue, tickets, now()
         FROM stg_sbm
       ON CONFLICT (tenant_id, product_id, warehouse_id, channel, year_month) DO UPDATE SET
         unit_kind=EXCLUDED.unit_kind, pieces=EXCLUDED.pieces, kg=EXCLUDED.kg, boxes=EXCLUDED.boxes,
         uxc=EXCLUDED.uxc, revenue=EXCLUDED.revenue, tickets=EXCLUDED.tickets, updated_at=now()
       WHERE (t.unit_kind, t.pieces, t.kg, t.boxes, t.uxc, t.revenue, t.tickets)
             IS DISTINCT FROM
             (EXCLUDED.unit_kind, EXCLUDED.pieces, EXCLUDED.kg, EXCLUDED.boxes, EXCLUDED.uxc, EXCLUDED.revenue, EXCLUDED.tickets)`);
    const del = await db.query(
      `DELETE FROM analytics.sales_boxes_monthly t
        WHERE t.tenant_id = $1
          AND NOT EXISTS (SELECT 1 FROM stg_sbm s
                           WHERE s.product_id = t.product_id AND s.warehouse_id = t.warehouse_id
                             AND s.channel = t.channel AND s.year_month = t.year_month)`, [M]);
    await db.query('COMMIT');
    // RS.12c — refrescar estadísticas: el bulk-upsert deja stats obsoletas → el planner
    // degrada el sell-out (medido: 7.5s → 1s con ANALYZE). Barato, corre en cada feed.
    await db.query(`ANALYZE analytics.sales_boxes_monthly`);
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas (desaparecidas). ANALYZE OK.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
