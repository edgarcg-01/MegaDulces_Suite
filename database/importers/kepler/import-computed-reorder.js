/* eslint-disable no-console */
/**
 * RA.3 + RA-PRO.1 — Reorden COMPUTADO por demanda → commercial.reorder_policy
 * (source='computed'). Ver FASE_RA_BENCHMARK_ENTERPRISE.md.
 *
 * Rellena los huecos que Kepler no configura (~82% del catálogo; CEDIS = 100%).
 * Transform 100% dentro de la plataforma (no toca Kepler): lee analytics.inventory_health
 * (avg_daily_units + σ + clase XYZ, poblado por import-inventory-health.js) + lead time
 * del proveedor + clase ABC (commercial.abc_classification).
 *
 * SAFETY STOCK POR NIVEL DE SERVICIO (estándar de la industria) — reemplaza el
 * heurístico de "días de cobertura fijos":
 *   safety_stock  = ceil( Z(service_level) × σ_demanda_diaria × √lead_time )
 *   reorder_point = ceil(avg_daily × lead_time) + safety_stock
 *   max_stock     = reorder_point + ceil(avg_daily × cycle_days)   (order-up-to; EOQ diferido)
 *
 * El nivel de servicio se asigna por clase ABC (A más alto que C — proteger lo caro):
 *   A = 0.98 · B = 0.95 · C / sin clase = 0.90   (override por env RA_SERVICE_A/B/C)
 * Z se deriva del nivel de servicio (inversa normal, Acklam) → funciona para cualquier valor.
 *
 * Fallback: productos sin σ (una sola venta, σ=0) → safety=0 por fórmula; para no dejar
 * clase A sin colchón se aplica un piso de RA_SAFETY_FLOOR_DAYS (default 2) días para A/B.
 *
 * NUNCA pisa source='kepler' ni 'manual' (ON CONFLICT ... WHERE source='computed').
 * Sólo productos con demanda (avg_daily_units > 0). Correr DESPUÉS de import-reorder-policy
 * (kepler manda) y de import-inventory-health (avg/σ frescos).
 *
 *   node database/importers/kepler/import-computed-reorder.js          # dry-run
 *   node database/importers/kepler/import-computed-reorder.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const LEAD_DEFAULT = Number(process.env.REORDER_LEAD_DEFAULT || 7);
const CYCLE_DAYS = Number(process.env.REORDER_CYCLE_DAYS || 14);
const SERVICE = {
  A: Number(process.env.RA_SERVICE_A || 0.98),
  B: Number(process.env.RA_SERVICE_B || 0.95),
  C: Number(process.env.RA_SERVICE_C || 0.90),
};
const SAFETY_FLOOR_DAYS = Number(process.env.RA_SAFETY_FLOOR_DAYS || 2);

// Inversa de la normal estándar (algoritmo de Acklam) → Z para un nivel de servicio p∈(0,1).
function invNorm(p) {
  if (p <= 0 || p >= 1) return 0;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p <= phigh) { q = p - 0.5; r = q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}
const Z = { A: invNorm(SERVICE.A), B: invNorm(SERVICE.B), C: invNorm(SERVICE.C) };

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Reorden por NIVEL DE SERVICIO → commercial.reorder_policy (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`  service A=${SERVICE.A}(Z=${Z.A.toFixed(3)}) B=${SERVICE.B}(Z=${Z.B.toFixed(3)}) C=${SERVICE.C}(Z=${Z.C.toFixed(3)}) · lead=${LEAD_DEFAULT}d cycle=${CYCLE_DAYS}d floor=${SAFETY_FLOOR_DAYS}d\n`);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    const res = await db.query(`
      WITH base AS (
        SELECT ih.warehouse_id, ih.product_id, ih.avg_daily_units AS adu,
               COALESCE(ih.stddev_daily_units,0) AS sigma, ih.demand_cv, ih.xyz_class,
               COALESCE(s.lead_time_days, $2) AS lead,
               COALESCE(abc.abc_class, 'C') AS abc_class
          FROM analytics.inventory_health ih
          JOIN catalog.products p ON p.tenant_id=$1 AND p.id=ih.product_id
          LEFT JOIN catalog.suppliers s ON s.tenant_id=$1 AND s.id=p.supplier_id
          LEFT JOIN commercial.abc_classification abc
                 ON abc.tenant_id=$1 AND abc.warehouse_id=ih.warehouse_id AND abc.product_id=ih.product_id
         WHERE ih.tenant_id=$1 AND ih.avg_daily_units > 0
      ), calc AS (
        SELECT warehouse_id, product_id, lead, abc_class, demand_cv, xyz_class, adu,
               CASE abc_class WHEN 'A' THEN $3::numeric WHEN 'B' THEN $4::numeric ELSE $5::numeric END AS service_level,
               GREATEST(
                 ceil( (CASE abc_class WHEN 'A' THEN $6::numeric WHEN 'B' THEN $7::numeric ELSE $8::numeric END) * sigma * sqrt(lead) ),
                 CASE WHEN abc_class IN ('A','B') THEN ceil(adu * $9) ELSE 0 END
               )::numeric AS safety,
               ceil(adu * lead)::numeric  AS lead_demand,
               ceil(adu * $10)::numeric   AS cycle_demand
          FROM base
      )
      INSERT INTO commercial.reorder_policy
        (id, tenant_id, warehouse_id, product_id, min_stock, reorder_point, max_stock, source,
         lead_time_days, safety_stock, service_level, abc_class, xyz_class, demand_cv, policy_method, computed_at, updated_at)
      SELECT gen_random_uuid(), $1, warehouse_id, product_id,
             safety, lead_demand + safety, lead_demand + safety + cycle_demand,
             'computed', lead, safety, service_level, abc_class, xyz_class, demand_cv, 'service_level', now(), now()
        FROM calc
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
        SET min_stock=EXCLUDED.min_stock, reorder_point=EXCLUDED.reorder_point, max_stock=EXCLUDED.max_stock,
            lead_time_days=EXCLUDED.lead_time_days, safety_stock=EXCLUDED.safety_stock,
            service_level=EXCLUDED.service_level, abc_class=EXCLUDED.abc_class, xyz_class=EXCLUDED.xyz_class,
            demand_cv=EXCLUDED.demand_cv, policy_method='service_level', computed_at=now(), updated_at=now()
        WHERE commercial.reorder_policy.source = 'computed'`,
      [M, LEAD_DEFAULT, SERVICE.A, SERVICE.B, SERVICE.C, Z.A, Z.B, Z.C, SAFETY_FLOOR_DAYS, CYCLE_DAYS]);

    console.log(`  filas computadas (insert+update de source='computed'): ${res.rowCount}`);

    // Distribución XYZ para sanity check
    const { rows: xyz } = await db.query(
      `SELECT COALESCE(xyz_class,'—') xyz, count(*) FROM commercial.reorder_policy
        WHERE tenant_id=$1 AND source='computed' GROUP BY 1 ORDER BY 1`, [M]);
    console.log('  XYZ:', xyz.map((r) => `${r.xyz}=${r.count}`).join(' '));

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    await db.query('COMMIT');
    console.log('\n[APPLY] COMMIT.');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
