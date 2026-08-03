/* eslint-disable no-console */
/**
 * RA-PRO.36 — Índice de Aceleración de Demanda (IAD) por SKU → analytics.demand_acceleration.
 *
 * Escala −2..+2: mide si el RITMO de demanda acelera/estable/desacelera (2da derivada), para
 * anticipar compra. Método (fijado con Jefe Frank):
 *   z_short    = Welch-Z( media diaria últimos 30d , media diaria días 31-60 )
 *   z_seasonal = Welch-Z( media diaria últimos 60d , mismos 60d del año anterior )
 *   iad        = clamp( 0.6·z_short + 0.4·z_seasonal , −2, +2 )   (sin base estacional → 100% z_short)
 *
 * Welch-Z = (μ_a − μ_b) / √(σ²_a/n_a + σ²_b/n_b), clamp −2..+2. μ/σ/n sobre DÍAS CON OPERACIÓN
 * (con venta) del bloque. Métrica = REVENUE diario de red (unit-agnóstico, escala-invariante → el
 * Z es idéntico al de piezas limpias; evita el lío cajas vs piezas). μ se reporta en PIEZAS vía
 * piece_price para lectura humana (no cambia el Z). Guard de spike: winsoriza el revenue diario al
 * p95 del SKU (mata mayoreo/liquidación puntual). Excluye SKUs promo ($0.01).
 *
 * Validaciones (marca status, no calcula iad): <60d de historia, <20 días con venta en 60d,
 * promedio anterior = 0. (Quiebres de inventario / pedidos extraordinarios: winsorización parcial;
 * exclusión fina diferida a v2.)
 *
 * Grano = (tenant, product). v1 = SOLO SEÑAL, no ajusta el sugerido. Refresco idempotente sin churn.
 *
 *   DATABASE_URL_NEW=…   node database/importers/kepler/import-demand-acceleration.js          # dry-run
 *   DST_URL=…railway     node database/importers/kepler/import-demand-acceleration.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

// CTE base: revenue diario de red por (product, date) en las 2 ventanas (60d actual + 60d YoY),
// winsorizado al p95 del SKU. μ reportada en piezas vía piece_price (de product_demand, constante
// por producto → no altera el Z). w_short/w_prior/w_cur/w_yoy = flags de bloque.
const CTE = `
  WITH pp AS (
    SELECT product_id, max(piece_price) AS piece_price
      FROM analytics.product_demand WHERE tenant_id = $1 AND window_days = 30 AND piece_price > 0
     GROUP BY product_id
  ),
  d0 AS (
    SELECT sd.product_id, sd.sale_date, sum(sd.revenue)::numeric AS rev
      FROM analytics.sales_daily sd
      JOIN catalog.products p ON p.id = sd.product_id AND p.tenant_id = sd.tenant_id AND p.is_promo IS NOT TRUE
     WHERE sd.tenant_id = $1 AND sd.units > 0 AND sd.revenue > 0
       AND (sd.sale_date >= current_date - 60
            OR sd.sale_date BETWEEN current_date - 425 AND current_date - 365)
     GROUP BY sd.product_id, sd.sale_date
  ),
  cap AS (  -- winsor p95 por SKU (spike guard)
    SELECT product_id, percentile_cont(0.95) WITHIN GROUP (ORDER BY rev) AS p95
      FROM d0 GROUP BY product_id
  ),
  d AS (
    SELECT d0.product_id, d0.sale_date,
           LEAST(d0.rev, GREATEST(cap.p95, 0.01)) AS rev
      FROM d0 JOIN cap USING (product_id)
  ),
  first_sale AS (
    SELECT product_id, min(sale_date) AS first_dt
      FROM analytics.sales_daily WHERE tenant_id = $1 AND sale_date > '2020-01-01' AND units > 0
     GROUP BY product_id
  ),
  agg AS (
    SELECT d.product_id,
      -- bloque reciente (últimos 30d)
      avg(rev) FILTER (WHERE sale_date >= current_date - 30)                               AS mu_r,
      coalesce(var_samp(rev) FILTER (WHERE sale_date >= current_date - 30), 0)             AS var_r,
      count(*)  FILTER (WHERE sale_date >= current_date - 30)                              AS n_r,
      -- bloque anterior (días 31-60)
      avg(rev) FILTER (WHERE sale_date >= current_date - 60 AND sale_date < current_date - 30)   AS mu_p,
      coalesce(var_samp(rev) FILTER (WHERE sale_date >= current_date - 60 AND sale_date < current_date - 30), 0) AS var_p,
      count(*)  FILTER (WHERE sale_date >= current_date - 60 AND sale_date < current_date - 30)  AS n_p,
      -- estacional: 60d actual vs mismos 60d año anterior
      avg(rev) FILTER (WHERE sale_date >= current_date - 60)                               AS mu_cur,
      coalesce(var_samp(rev) FILTER (WHERE sale_date >= current_date - 60), 0)             AS var_cur,
      count(*)  FILTER (WHERE sale_date >= current_date - 60)                              AS n_cur,
      avg(rev) FILTER (WHERE sale_date BETWEEN current_date - 425 AND current_date - 365)  AS mu_yoy,
      coalesce(var_samp(rev) FILTER (WHERE sale_date BETWEEN current_date - 425 AND current_date - 365), 0) AS var_yoy,
      count(*)  FILTER (WHERE sale_date BETWEEN current_date - 425 AND current_date - 365) AS n_yoy
    FROM d GROUP BY d.product_id
  ),
  z AS (
    SELECT a.product_id, a.mu_r, a.var_r, a.n_r, a.mu_p, a.var_p, a.n_p,
           a.mu_cur, a.mu_yoy, a.n_cur, a.n_yoy, a.var_cur, a.var_yoy,
           fs.first_dt, pp.piece_price,
           -- Welch-Z corto (30 vs 30), clamp −2..+2. denom 0 → ±2 por signo.
           CASE WHEN a.n_r >= 2 AND a.n_p >= 2 AND a.mu_p > 0 THEN
             CASE WHEN (a.var_r/a.n_r + a.var_p/a.n_p) > 0
                  THEN GREATEST(-2, LEAST(2, (a.mu_r - a.mu_p) / sqrt(a.var_r/a.n_r + a.var_p/a.n_p)))
                  WHEN a.mu_r > a.mu_p THEN 2 WHEN a.mu_r < a.mu_p THEN -2 ELSE 0 END
           END AS z_short,
           -- Welch-Z estacional (60d vs 60d YoY)
           CASE WHEN a.n_cur >= 2 AND a.n_yoy >= 2 AND a.mu_yoy > 0 THEN
             CASE WHEN (a.var_cur/a.n_cur + a.var_yoy/a.n_yoy) > 0
                  THEN GREATEST(-2, LEAST(2, (a.mu_cur - a.mu_yoy) / sqrt(a.var_cur/a.n_cur + a.var_yoy/a.n_yoy)))
                  WHEN a.mu_cur > a.mu_yoy THEN 2 WHEN a.mu_cur < a.mu_yoy THEN -2 ELSE 0 END
           END AS z_seasonal
      FROM agg a JOIN first_sale fs USING (product_id) LEFT JOIN pp USING (product_id)
  ),
  final AS (
    SELECT z.*,
      (z.z_seasonal IS NOT NULL) AS has_seasonal,
      CASE
        WHEN z.first_dt > current_date - 60 THEN 'insufficient_history'
        WHEN z.n_cur < 20                    THEN 'insufficient_sales'
        WHEN z.z_short IS NULL AND z.z_seasonal IS NULL THEN 'no_prior'
        ELSE 'ok' END AS status,
      CASE
        WHEN z.first_dt > current_date - 60 OR z.n_cur < 20 THEN NULL
        WHEN z.z_short IS NOT NULL AND z.z_seasonal IS NOT NULL
             THEN GREATEST(-2, LEAST(2, 0.6*z.z_short + 0.4*z.z_seasonal))
        WHEN z.z_short IS NOT NULL   THEN z.z_short
        WHEN z.z_seasonal IS NOT NULL THEN z.z_seasonal
        ELSE NULL END AS iad
      FROM z
  )
  SELECT f.product_id, p.sku, p.nombre AS nombre,
         round((f.mu_r  / NULLIF(f.piece_price,0))::numeric, 2) AS mu_recent,
         round((sqrt(f.var_r) / NULLIF(f.piece_price,0))::numeric, 2) AS sd_recent, f.n_r AS n_recent,
         round((f.mu_p  / NULLIF(f.piece_price,0))::numeric, 2) AS mu_prior,
         round((sqrt(f.var_p) / NULLIF(f.piece_price,0))::numeric, 2) AS sd_prior, f.n_p AS n_prior,
         round(f.z_short::numeric, 2) AS z_short,
         round((f.mu_cur / NULLIF(f.piece_price,0))::numeric, 2) AS mu_cur60,
         round((f.mu_yoy / NULLIF(f.piece_price,0))::numeric, 2) AS mu_yoy60,
         round(f.z_seasonal::numeric, 2) AS z_seasonal, f.has_seasonal,
         round(f.iad::numeric, 2) AS iad,
         CASE
           WHEN f.iad IS NULL THEN NULL
           WHEN f.iad >=  1.5  THEN 'accel_extra'
           WHEN f.iad >=  0.75 THEN 'accel'
           WHEN f.iad >=  0.25 THEN 'accel_leve'
           WHEN f.iad >  -0.25 THEN 'estable'
           WHEN f.iad >  -0.75 THEN 'desacel_leve'
           WHEN f.iad >  -1.5  THEN 'desacel'
           ELSE 'desacel_extra' END AS band,
         f.status
    FROM final f JOIN catalog.products p ON p.id = f.product_id AND p.tenant_id = $1`;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== IAD → analytics.demand_acceleration (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    const s = await db.query(
      `WITH r AS (${CTE})
       SELECT count(*)::int filas,
              count(*) FILTER (WHERE status='ok')::int ok,
              count(*) FILTER (WHERE band='accel_extra')::int ax,
              count(*) FILTER (WHERE band IN ('accel','accel_leve'))::int acc,
              count(*) FILTER (WHERE band='estable')::int est,
              count(*) FILTER (WHERE band IN ('desacel_leve','desacel'))::int des,
              count(*) FILTER (WHERE band='desacel_extra')::int dx,
              count(*) FILTER (WHERE has_seasonal)::int con_estacional
         FROM r`, [M]);
    const r = s.rows[0];
    console.log(`  filas=${r.filas} · ok=${r.ok} · con estacional=${r.con_estacional}`);
    console.log(`  bandas: ▲▲ ${r.ax} · ▲ ${r.acc} · ═ ${r.est} · ▼ ${r.des} · ▼▼ ${r.dx}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_iad ON COMMIT DROP AS
      SELECT $1::uuid tenant_id, product_id, sku, nombre, mu_recent, sd_recent, n_recent,
             mu_prior, sd_prior, n_prior, z_short, mu_cur60, mu_yoy60, z_seasonal, has_seasonal,
             iad, band, status, now() computed_at
        FROM (${CTE}) x`, [M]);
    const up = await db.query(`
      INSERT INTO analytics.demand_acceleration AS t
        (tenant_id, product_id, sku, nombre, mu_recent, sd_recent, n_recent, mu_prior, sd_prior, n_prior,
         z_short, mu_cur60, mu_yoy60, z_seasonal, has_seasonal, iad, band, status, computed_at)
      SELECT tenant_id, product_id, sku, nombre, mu_recent, sd_recent, n_recent, mu_prior, sd_prior, n_prior,
             z_short, mu_cur60, mu_yoy60, z_seasonal, has_seasonal, iad, band, status, computed_at
        FROM stg_iad
      ON CONFLICT (tenant_id, product_id) DO UPDATE SET
        sku=EXCLUDED.sku, nombre=EXCLUDED.nombre, mu_recent=EXCLUDED.mu_recent, sd_recent=EXCLUDED.sd_recent,
        n_recent=EXCLUDED.n_recent, mu_prior=EXCLUDED.mu_prior, sd_prior=EXCLUDED.sd_prior, n_prior=EXCLUDED.n_prior,
        z_short=EXCLUDED.z_short, mu_cur60=EXCLUDED.mu_cur60, mu_yoy60=EXCLUDED.mu_yoy60, z_seasonal=EXCLUDED.z_seasonal,
        has_seasonal=EXCLUDED.has_seasonal, iad=EXCLUDED.iad, band=EXCLUDED.band, status=EXCLUDED.status, computed_at=now()
      WHERE (t.iad, t.band, t.status, t.z_short, t.z_seasonal)
            IS DISTINCT FROM
            (EXCLUDED.iad, EXCLUDED.band, EXCLUDED.status, EXCLUDED.z_short, EXCLUDED.z_seasonal)`);
    const del = await db.query(
      `DELETE FROM analytics.demand_acceleration t
        WHERE t.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM stg_iad s WHERE s.product_id = t.product_id)`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
