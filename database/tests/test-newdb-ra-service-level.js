/* eslint-disable no-console */
/**
 * RA-PRO.1 + RA-PRO.2 — Smoke de reabastecimiento profesional (safety stock por
 * NIVEL DE SERVICIO + segmentación XYZ). Ver FASE_RA_BENCHMARK_ENTERPRISE.md.
 *
 * DB-direct, autocontenido: siembra series de venta CONOCIDAS en analytics.sales_daily
 * y verifica contra valores calculados a mano:
 *   · σ (desviación poblacional 90d con días cero) y CV = σ/μ
 *   · clase XYZ (X≤0.5 · Y≤1.0 · Z>1.0)
 *   · safety_stock = ceil( Z(nivel_servicio) × σ × √lead ) con piso por días para A/B
 *   · reorder_point / max_stock
 *   · columnas nuevas + CHECK de commercial.reorder_policy (service_level/abc/xyz/method)
 * Todo en UNA transacción con ROLLBACK — no persiste.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function near(a, b, tol) { return Math.abs(Number(a) - Number(b)) <= (tol || 0.01); }

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

const STAT_SQL = (pid) => `
  WITH vel AS (
    SELECT sum(units) u, sum(units*units) sq
      FROM analytics.sales_daily
     WHERE tenant_id='${T}' AND sale_date >= current_date - 90 AND product_id='${pid}'
  ), stat AS (
    SELECT (u/90.0) mu, sqrt(GREATEST(0, sq/90.0 - power(u/90.0,2))) sigma FROM vel
  )
  SELECT round(mu,4) mu, round(sigma,4) sigma,
         CASE WHEN COALESCE(mu,0)=0 THEN NULL WHEN sigma/mu<=0.5 THEN 'X' WHEN sigma/mu<=1.0 THEN 'Y' ELSE 'Z' END xyz
    FROM stat`;

(async () => {
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // ── 0. Schema (columnas nuevas) ─────────────────────────────────────
      const hasCol = async (sc, tb, c) => (await trx.raw(
        `select 1 from information_schema.columns where table_schema=? and table_name=? and column_name=?`, [sc, tb, c])).rows.length > 0;
      ok(await hasCol('analytics', 'inventory_health', 'stddev_daily_units'), 'col inventory_health.stddev_daily_units');
      ok(await hasCol('analytics', 'inventory_health', 'xyz_class'), 'col inventory_health.xyz_class');
      ok(await hasCol('commercial', 'reorder_policy', 'service_level'), 'col reorder_policy.service_level');
      ok(await hasCol('commercial', 'reorder_policy', 'policy_method'), 'col reorder_policy.policy_method');

      const wh = await trx('commercial.warehouses').where('tenant_id', T).first('id');
      const prods = await trx('catalog.products').where('tenant_id', T).limit(2).select('id');
      ok(!!wh && prods.length >= 2, 'data base local (almacén + 2 productos)');
      const pErr = prods[0].id, pStable = prods[1].id;

      // ── 1. Serie ERRÁTICA: 3 días × 30 uds (resto cero) → μ=1, σ=√29, Z ──
      await trx.raw(`INSERT INTO analytics.sales_daily (tenant_id,product_id,warehouse_id,channel,sale_date,units,revenue,tickets)
        SELECT '${T}','${pErr}','${wh.id}','test', current_date - g, 30, 0, 1 FROM generate_series(1,3) g`);
      const e = (await trx.raw(STAT_SQL(pErr))).rows[0];
      const sigmaErr = Math.sqrt(29); // 5.385164807...
      ok(near(e.mu, 1.0), `errático μ = ${e.mu} (esperado 1.0)`);
      ok(near(e.sigma, sigmaErr, 0.001), `errático σ = ${e.sigma} (esperado ${sigmaErr.toFixed(4)})`);
      ok(e.xyz === 'Z', `errático clase XYZ = ${e.xyz} (esperado Z, CV=${(e.sigma/e.mu).toFixed(2)})`);

      // ── 2. Serie ESTABLE: 90 días × 10 uds → μ=10, σ=0, X ───────────────
      await trx.raw(`INSERT INTO analytics.sales_daily (tenant_id,product_id,warehouse_id,channel,sale_date,units,revenue,tickets)
        SELECT '${T}','${pStable}','${wh.id}','test', current_date - g, 10, 0, 1 FROM generate_series(0,89) g`);
      const s = (await trx.raw(STAT_SQL(pStable))).rows[0];
      ok(near(s.mu, 10.0), `estable μ = ${s.mu} (esperado 10.0)`);
      ok(near(s.sigma, 0, 0.0001), `estable σ = ${s.sigma} (esperado 0)`);
      ok(s.xyz === 'X', `estable clase XYZ = ${s.xyz} (esperado X)`);

      // ── 3. Safety stock por nivel de servicio (fórmula estándar) ────────
      const lead = 7, sqrtLead = Math.sqrt(lead), floorDays = 2;
      // Errático como clase A (servicio 0.98): fórmula domina al piso.
      const zA = invNorm(0.98);
      ok(near(zA, 2.0537, 0.001), `Z(0.98) = ${zA.toFixed(4)} (esperado 2.0537)`);
      const ssErr = Math.max(Math.ceil(zA * Number(e.sigma) * sqrtLead), Math.ceil(Number(e.mu) * floorDays));
      const ropErr = Math.ceil(Number(e.mu) * lead) + ssErr;
      ok(ssErr === 30, `errático(A) safety = ${ssErr} (ceil(${zA.toFixed(3)}×${Number(e.sigma).toFixed(3)}×√7)=30)`);
      ok(ropErr === 37, `errático(A) reorder_point = ${ropErr} (ceil(1×7)+30=37)`);

      // Estable como clase A (σ=0): fórmula=0 → domina el PISO = ceil(10×2)=20.
      const ssStable = Math.max(Math.ceil(zA * Number(s.sigma) * sqrtLead), Math.ceil(Number(s.mu) * floorDays));
      ok(ssStable === 20, `estable(A) safety = ${ssStable} (fórmula 0 → piso ceil(10×2)=20)`);

      // Nivel de servicio por clase: A > B > C.
      ok(invNorm(0.98) > invNorm(0.95) && invNorm(0.95) > invNorm(0.90), 'Z crece con el nivel de servicio (A>B>C)');

      // ── 4. reorder_policy: persistencia + columnas + CHECK ──────────────
      await trx('commercial.reorder_policy').insert({
        tenant_id: T, warehouse_id: wh.id, product_id: pErr,
        min_stock: ssErr, reorder_point: ropErr, max_stock: ropErr + 14,
        source: 'computed', lead_time_days: lead, safety_stock: ssErr,
        service_level: 0.98, abc_class: 'A', xyz_class: 'Z', demand_cv: Number(e.sigma) / Number(e.mu),
        policy_method: 'service_level',
      }).onConflict(['tenant_id', 'warehouse_id', 'product_id']).merge();
      const rp = await trx('commercial.reorder_policy').where({ tenant_id: T, warehouse_id: wh.id, product_id: pErr })
        .first('safety_stock', 'service_level', 'abc_class', 'xyz_class', 'policy_method');
      ok(Number(rp.safety_stock) === 30 && rp.policy_method === 'service_level' && rp.abc_class === 'A' && rp.xyz_class === 'Z',
        'reorder_policy persiste safety/service_level/abc/xyz/method');

      let checkRej = false;
      try {
        await trx.raw(`SAVEPOINT sp`);
        await trx('commercial.reorder_policy').where({ tenant_id: T, warehouse_id: wh.id, product_id: pErr }).update({ xyz_class: 'Q' });
        await trx.raw(`ROLLBACK TO SAVEPOINT sp`);
      } catch { checkRej = true; await trx.raw(`ROLLBACK TO SAVEPOINT sp`); }
      ok(checkRej, 'CHECK rechaza xyz_class inválido (Q)');

      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error('ERROR:', e.message); fail++; }
  } finally { await knex.destroy(); }

  console.log(`\nRA-PRO service-level smoke: ${pass} OK, ${fail} fallidos`);
  process.exit(fail === 0 ? 0 : 1);
})();
