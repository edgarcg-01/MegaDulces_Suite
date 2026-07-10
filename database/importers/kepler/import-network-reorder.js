/* eslint-disable no-console */
/**
 * RA-PRO.6 — Reorden del CEDIS por DEMANDA DEPENDIENTE (DRP / multi-echelon).
 * Ver FASE_RA_BENCHMARK_ENTERPRISE.md.
 *
 * El CEDIS no vende directo (su avg diario ≈ 0) → planearlo por su propia venta lo
 * deja sin política y las sucursales no pueden surtirse de él. DRP lo planea por lo que
 * la RED consume: para cada almacén origen (CEDIS = el referenciado por
 * `warehouses.source_warehouse_id`), agrega la demanda de TODAS sus sucursales:
 *   media_red  = Σ avg_daily(sucursal) + avg_daily(propio CEDIS)
 *   σ_red      = √( Σ σ(sucursal)² + σ(propio)² )     ← risk pooling (varianzas suman)
 *   safety     = ceil( Z(servicio_cedis) × σ_red × √lead )
 *   reorder    = ceil(media_red × lead) + safety ;  max = reorder + ceil(media_red × cycle)
 *
 * Escribe reorder_policy del CEDIS (source='computed', policy_method='service_level').
 * NUNCA pisa kepler/manual. Correr DESPUÉS de import-inventory-health (avg/σ frescos).
 *
 *   node database/importers/kepler/import-network-reorder.js          # dry-run
 *   node database/importers/kepler/import-network-reorder.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const LEAD_DEFAULT = Number(process.env.REORDER_LEAD_DEFAULT || 7);
const CYCLE_DAYS = Number(process.env.REORDER_CYCLE_DAYS || 14);
const CEDIS_SERVICE = Number(process.env.RA_CEDIS_SERVICE || 0.98); // el hub protege a toda la red

// Inversa normal (Acklam) — misma que import-computed-reorder.js.
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow; let q, r;
  if (p < plow) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p <= phigh) { q = p - 0.5; r = q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
  q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}
const Z = invNorm(CEDIS_SERVICE);

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== DRP: reorden del CEDIS por demanda dependiente (${APPLY ? 'APPLY' : 'DRY-RUN'}; servicio=${CEDIS_SERVICE} Z=${Z.toFixed(3)} lead=${LEAD_DEFAULT}d cycle=${CYCLE_DAYS}d) ===\n`);

    const { rows: topo } = await db.query(
      `SELECT src.code cedis, count(*) sucursales
         FROM commercial.warehouses w
         JOIN commercial.warehouses src ON src.tenant_id=w.tenant_id AND src.id=w.source_warehouse_id
        WHERE w.tenant_id=$1 AND w.source_warehouse_id IS NOT NULL AND w.deleted_at IS NULL
        GROUP BY src.code`, [M]);
    if (!topo.length) { console.log('  ⚠ Sin topología de red configurada (ninguna sucursal con source_warehouse_id). Nada que planear.'); await db.query('ROLLBACK').catch(()=>{}); return; }
    console.log('  topología:', topo.map((t) => `${t.cedis}←${t.sucursales} suc`).join(' · '));

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    const res = await db.query(`
      WITH branch AS (
        SELECT w.source_warehouse_id AS cedis_id, ih.product_id,
               ih.avg_daily_units adu, COALESCE(ih.stddev_daily_units,0) sd
          FROM commercial.warehouses w
          JOIN analytics.inventory_health ih ON ih.tenant_id=$1 AND ih.warehouse_id=w.id
         WHERE w.tenant_id=$1 AND w.source_warehouse_id IS NOT NULL AND w.deleted_at IS NULL
           AND ih.avg_daily_units > 0
      ), bagg AS (
        SELECT cedis_id, product_id, sum(adu) badu, sum(sd*sd) bvar FROM branch GROUP BY cedis_id, product_id
      ), agg AS (
        SELECT ba.cedis_id, ba.product_id,
               ba.badu + COALESCE(o.avg_daily_units,0) AS net_mean,
               sqrt( ba.bvar + COALESCE(power(o.stddev_daily_units,2),0) ) AS net_sigma
          FROM bagg ba
          LEFT JOIN analytics.inventory_health o ON o.tenant_id=$1 AND o.warehouse_id=ba.cedis_id AND o.product_id=ba.product_id
      ), calc AS (
        SELECT a.cedis_id, a.product_id, a.net_mean, a.net_sigma,
               COALESCE(s.lead_time_days, $2) AS lead,
               COALESCE(abc.abc_class, 'A') AS abc_class,
               CASE WHEN a.net_mean>0 THEN a.net_sigma/a.net_mean END AS cv
          FROM agg a
          JOIN catalog.products p ON p.tenant_id=$1 AND p.id=a.product_id
          LEFT JOIN catalog.suppliers s ON s.tenant_id=$1 AND s.id=p.supplier_id
          LEFT JOIN commercial.abc_classification abc ON abc.tenant_id=$1 AND abc.warehouse_id=a.cedis_id AND abc.product_id=a.product_id
         WHERE a.net_mean > 0
      )
      INSERT INTO commercial.reorder_policy
        (id, tenant_id, warehouse_id, product_id, min_stock, reorder_point, max_stock, source,
         lead_time_days, safety_stock, service_level, abc_class, xyz_class, demand_cv, policy_method, computed_at, updated_at)
      SELECT gen_random_uuid(), $1, cedis_id, product_id,
             ceil($5 * net_sigma * sqrt(lead)),
             ceil(net_mean * lead) + ceil($5 * net_sigma * sqrt(lead)),
             ceil(net_mean * lead) + ceil($5 * net_sigma * sqrt(lead)) + ceil(net_mean * $4),
             'computed', lead, ceil($5 * net_sigma * sqrt(lead)), $3, abc_class,
             CASE WHEN cv IS NULL THEN NULL WHEN cv<=0.5 THEN 'X' WHEN cv<=1.0 THEN 'Y' ELSE 'Z' END,
             cv, 'service_level', now(), now()
        FROM calc
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
        SET min_stock=EXCLUDED.min_stock, reorder_point=EXCLUDED.reorder_point, max_stock=EXCLUDED.max_stock,
            lead_time_days=EXCLUDED.lead_time_days, safety_stock=EXCLUDED.safety_stock, service_level=EXCLUDED.service_level,
            abc_class=EXCLUDED.abc_class, xyz_class=EXCLUDED.xyz_class, demand_cv=EXCLUDED.demand_cv,
            policy_method='service_level', computed_at=now(), updated_at=now()
        WHERE commercial.reorder_policy.source = 'computed'`,
      [M, LEAD_DEFAULT, CEDIS_SERVICE, CYCLE_DAYS, Z]);

    console.log(`  filas de política del CEDIS (insert+update source='computed'): ${res.rowCount}`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }
    await db.query('COMMIT');
    console.log('\n[APPLY] COMMIT.');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
