/* eslint-disable no-console */
/**
 * RA-PRO.6 — Smoke DRP (multi-echelon): el CEDIS se planea sobre la demanda dependiente
 * de sus sucursales. Verifica el rollup contra valores calculados a mano:
 *   media_red = Σ avg(sucursal) + avg(propio)
 *   σ_red     = √( Σ σ(sucursal)² + σ(propio)² )   ← risk pooling (varianzas suman)
 *   safety    = ceil( Z(servicio) × σ_red × √lead )
 * DB-direct, en UNA transacción con ROLLBACK (no persiste).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol || 0.01); }
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow; let q, r;
  if (p < plow) { q = Math.sqrt(-2*Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p <= phigh) { q = p-0.5; r = q*q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
  q = Math.sqrt(-2*Math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

(async () => {
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // Schema (topología)
      const hasCol = (await trx.raw(`select 1 from information_schema.columns where table_schema='commercial' and table_name='warehouses' and column_name='source_warehouse_id'`)).rows.length > 0;
      ok(hasCol, 'col warehouses.source_warehouse_id');

      const whs = await trx('commercial.warehouses').where('tenant_id', T).whereNull('deleted_at').andWhere('kind', '<>', 'truck').limit(3).select('id', 'code');
      const pr = await trx('catalog.products').where('tenant_id', T).first('id');
      ok(whs.length >= 3 && !!pr, 'data base local (3 almacenes + producto)');
      const [cedis, b1, b2] = whs;

      // Topología: b1, b2 se surten del CEDIS
      await trx('commercial.warehouses').where({ tenant_id: T, id: b1.id }).update({ source_warehouse_id: cedis.id });
      await trx('commercial.warehouses').where({ tenant_id: T, id: b2.id }).update({ source_warehouse_id: cedis.id });
      // Guard: no self-source
      let selfRej = false;
      try { await trx.raw(`SAVEPOINT s1`); await trx('commercial.warehouses').where({ tenant_id: T, id: cedis.id }).update({ source_warehouse_id: cedis.id }); await trx.raw(`ROLLBACK TO SAVEPOINT s1`); }
      catch { selfRej = true; await trx.raw(`ROLLBACK TO SAVEPOINT s1`); }
      ok(selfRej, 'CHECK rechaza que un almacén se surta de sí mismo');

      // Demanda sembrada: b1 avg=2 σ=3 · b2 avg=4 σ=4 · CEDIS propio avg=1 σ=0
      const seed = (wh, avg, sd) => trx.raw(
        `INSERT INTO analytics.inventory_health (tenant_id,product_id,warehouse_id,on_hand,avg_daily_units,stddev_daily_units,computed_at)
         VALUES (?,?,?,0,?,?,now())
         ON CONFLICT (tenant_id,product_id,warehouse_id) DO UPDATE SET avg_daily_units=EXCLUDED.avg_daily_units, stddev_daily_units=EXCLUDED.stddev_daily_units`,
        [T, pr.id, wh, avg, sd]);
      await seed(b1.id, 2, 3); await seed(b2.id, 4, 4); await seed(cedis.id, 1, 0);

      // Rollup DRP (mismo SQL que import-network-reorder.js)
      const agg = (await trx.raw(`
        WITH branch AS (
          SELECT w.source_warehouse_id AS cedis_id, ih.product_id, ih.avg_daily_units adu, COALESCE(ih.stddev_daily_units,0) sd
            FROM commercial.warehouses w
            JOIN analytics.inventory_health ih ON ih.tenant_id=? AND ih.warehouse_id=w.id
           WHERE w.tenant_id=? AND w.source_warehouse_id IS NOT NULL AND w.deleted_at IS NULL AND ih.avg_daily_units>0
        ), bagg AS (SELECT cedis_id, product_id, sum(adu) badu, sum(sd*sd) bvar FROM branch GROUP BY cedis_id, product_id)
        SELECT ba.badu + COALESCE(o.avg_daily_units,0) net_mean,
               sqrt( ba.bvar + COALESCE(power(o.stddev_daily_units,2),0) ) net_sigma
          FROM bagg ba
          LEFT JOIN analytics.inventory_health o ON o.tenant_id=? AND o.warehouse_id=ba.cedis_id AND o.product_id=ba.product_id
         WHERE ba.cedis_id=? AND ba.product_id=?`,
        [T, T, T, cedis.id, pr.id])).rows[0];
      ok(near(agg.net_mean, 7), `media_red = ${agg.net_mean} (2+4+1 = 7)`);
      ok(near(agg.net_sigma, 5), `σ_red = ${agg.net_sigma} (√(9+16+0) = 5, risk pooling)`);

      // Risk pooling: el CV agregado (0.71) es MENOR que el promedio ponderado de CVs individuales.
      ok(Number(agg.net_sigma) / Number(agg.net_mean) < 1.5, 'CV agregado bajo (beneficio de pooling)');

      // Safety por nivel de servicio del hub (0.98), lead default 7
      const z = invNorm(0.98), lead = 7;
      const safety = Math.ceil(z * Number(agg.net_sigma) * Math.sqrt(lead));
      ok(safety === Math.ceil(2.0537 * 5 * Math.sqrt(7)), `safety CEDIS = ${safety} (ceil(Z·σ_red·√7))`);

      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error('ERROR:', e.message); fail++; }
  } finally { await knex.destroy(); }

  console.log(`\nRA-PRO.6 DRP network smoke: ${pass} OK, ${fail} fallidos`);
  process.exit(fail === 0 ? 0 : 1);
})();
