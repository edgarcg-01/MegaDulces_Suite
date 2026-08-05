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
// RA-PRO.40 — piloto: para las marcas en scope, la demanda diaria se ancla a REVENUE
// (revenue_día × box_factor / cja_price = venta en la unidad REAL, ej. PAQ) en vez de sum(units),
// que mezcla piezas (mostrador) + cajas (Wincaja) e infla ~8-16× (rompe la consistencia con el
// stock, que está en PAQ). Fuera de scope o sin cja_price → sum(units) crudo intacto.
const MONEY_BRAND_LIKE = process.env.MONEY_ANCHOR_BRAND_LIKE || '%rosa%';

// UNIDAD CANÓNICA = PIEZAS (decidido 2026-07-27, verificado contra movimientos de COMPRA reales).
// El motor de reabasto trabaja TODO en piezas porque las 3 señales de Kepler ya viven en piezas y
// balancean entre sí (entrada X-A-40 ⋈ salida/venta ⋈ existencia kdil):
//   · stock.quantity (kdil c4+c8−c9)                → PIEZAS
//   · sales_daily.units (POS/Wincaja, conteo)       → PIEZAS
//   · cost_with_tax (kdik.c16, = unit_cost de la entrada, amount = qty_pz × cost) → por PIEZA
// El intento previo de normalizar a CAJAS (units_base ÷ factor_sale) rompía la consistencia contra
// stock/costo (que NO se convertían) e inflaba/deflactaba ×factor según disparara una regla frágil.
// Aquí la demanda es la venta CRUDA en piezas (units). La caja es solo DISPLAY (piezas ÷ factor_sale
// en el front / service). Ver reference_box_factor_factor_sale + FASE_CT/FASE_RA.
//
// norm agrega a nivel (producto×almacén×DÍA); luego vel calcula los momentos sobre esos totales
// diarios. Para la dispersión (σ) sobre la población de 90 días (INCLUYE los días sin venta como
// cero) usamos los momentos:
//   μ = Σu / 90     σ = sqrt( Σu² / 90 − μ² )   (varianza poblacional, N=90)
// dividimos entre 90 (no entre el nº de días con venta). CV = σ/μ → XYZ (X≤0.5 / Y≤1 / Z>1).
const SELECT_HEALTH = `
  WITH norm AS (
    SELECT sd.product_id, sd.warehouse_id, sd.sale_date::date AS d,
           -- RA-PRO.40: money-anchored para marcas en scope (unidad REAL vía cja_price), si no units crudas
           CASE WHEN b.nombre ILIKE '${MONEY_BRAND_LIKE}' AND bp.cja_price > 0 AND vbf.box_factor > 0
                     AND max(sd.unit_kind) IS DISTINCT FROM 'weight'
                THEN sum(sd.revenue) * vbf.box_factor / bp.cja_price
                ELSE sum(sd.units) END AS units_day
      FROM analytics.sales_daily sd
      JOIN catalog.products p ON p.tenant_id = sd.tenant_id AND p.id = sd.product_id
      LEFT JOIN catalog.brands b ON b.id = p.brand_id
      LEFT JOIN analytics.product_box_price   bp  ON bp.tenant_id = sd.tenant_id AND bp.product_id = sd.product_id AND bp.cja_price > 0
      LEFT JOIN analytics.v_product_box_factor vbf ON vbf.tenant_id = sd.tenant_id AND vbf.product_id = sd.product_id
     WHERE sd.tenant_id = $1 AND sd.sale_date >= current_date - 90 AND (sd.units > 0 OR sd.revenue > 0)
     GROUP BY sd.product_id, sd.warehouse_id, sd.sale_date::date, b.nombre, bp.cja_price, vbf.box_factor
  ), vel AS (
    SELECT product_id, warehouse_id,
           sum(units_day)            AS units_90d,
           sum(units_day*units_day)  AS sumsq_90d
      FROM norm
     GROUP BY product_id, warehouse_id
  ), stat AS (
    SELECT product_id, warehouse_id, units_90d,
           (units_90d / 90.0) AS mu,
           sqrt(GREATEST(0, sumsq_90d / 90.0 - power(units_90d / 90.0, 2))) AS sigma
      FROM vel
  )
  SELECT s.product_id, s.warehouse_id,
         s.quantity AS on_hand,
         round(COALESCE(v.units_90d,0) / 90.0, 4) AS avg_daily_units,
         round(COALESCE(v.sigma,0), 4)            AS stddev_daily_units,
         CASE WHEN COALESCE(v.mu,0) > 0 THEN round(v.sigma / v.mu, 4) END AS demand_cv,
         CASE
           WHEN COALESCE(v.mu,0) = 0 THEN NULL
           WHEN v.sigma / v.mu <= 0.5 THEN 'X'
           WHEN v.sigma / v.mu <= 1.0 THEN 'Y'
           ELSE 'Z'
         END AS xyz_class,
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
    LEFT JOIN stat v ON v.product_id = s.product_id AND v.warehouse_id = s.warehouse_id
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
      `INSERT INTO analytics.inventory_health AS t
         (tenant_id, product_id, warehouse_id, on_hand, avg_daily_units, stddev_daily_units, demand_cv, xyz_class, days_cover, status, computed_at)
       SELECT $1, product_id, warehouse_id, on_hand, avg_daily_units, stddev_daily_units, demand_cv, xyz_class, days_cover, status, now()
         FROM (${SELECT_HEALTH}) h
       ON CONFLICT (tenant_id, product_id, warehouse_id) DO UPDATE SET
         on_hand=EXCLUDED.on_hand, avg_daily_units=EXCLUDED.avg_daily_units,
         stddev_daily_units=EXCLUDED.stddev_daily_units, demand_cv=EXCLUDED.demand_cv, xyz_class=EXCLUDED.xyz_class,
         days_cover=EXCLUDED.days_cover, status=EXCLUDED.status, computed_at=now()
       WHERE (t.on_hand, t.avg_daily_units, t.stddev_daily_units, t.demand_cv, t.xyz_class, t.days_cover, t.status)
             IS DISTINCT FROM
             (EXCLUDED.on_hand, EXCLUDED.avg_daily_units, EXCLUDED.stddev_daily_units, EXCLUDED.demand_cv,
              EXCLUDED.xyz_class, EXCLUDED.days_cover, EXCLUDED.status)`, [M]);
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
