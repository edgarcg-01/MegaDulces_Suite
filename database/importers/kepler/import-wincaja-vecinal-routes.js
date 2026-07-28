/* eslint-disable no-console */
/**
 * RR — Rollup de la VENTA VECINAL HISTÓRICA de Wincaja (Padre Hidalgo) como ruta en la
 * matriz de /comercial/ventas-por-ruta, para que la ruta vecinal de PH tenga timeline
 * completo: Wincaja (ene–jun) + Kepler `1V001`/`1V002` (jul→).
 *
 * La vecinal de PH vive en Wincaja como canal `preventa_vecinal` (suc '10', ene–jun 2026,
 * congelada en el cutover). El line-level lo surface ya la vista `v_route_sales_lines`
 * (3er UNION, mig 20260728120000) sin copiar filas; este feed cierra las dos piezas de
 * DATOS (no schema, fuera del boot de Railway):
 *   1) registra la branch histórica `VEC-PH-H` (is_route, parent='10') en wincaja.branches,
 *   2) agrega el rollup mensual → `analytics.sales_by_route_monthly` (`WIN-VEC-PH-H`).
 *
 * Frozen (ene–jun): correrlo una vez basta; es idempotente (GREATEST) si se re-corre.
 * Fuente y destino = la MISMA DB (lee wincaja.v_sales_lines, escribe analytics.*).
 *
 *   DST_URL / DATABASE_URL_NEW = destino (prod Railway)
 *   node database/importers/kepler/import-wincaja-vecinal-routes.js           # dry-run
 *   node database/importers/kepler/import-wincaja-vecinal-routes.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const PARENT = process.env.PARENT || '10';   // suc madre PH en wincaja.branches
const ROUTE = 'VEC-PH-H';                     // ruta histórica (código estable)
const NAME = 'RUTA VECINAL PH (histórico Wincaja)';
const CUTOVER = '2026-06-27';                 // corte anti-solape con Kepler

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  try {
    console.log(`\n=== VECINAL histórica Wincaja (PH) → sales_by_route_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // suc madre → warehouse (mismo COALESCE que resuelve el servicio)
    const par = (await dst.query(
      `SELECT COALESCE(kepler_code, warehouse_code) AS wcode, branch_name FROM wincaja.branches WHERE tenant_id=$1 AND source_branch=$2`, [M, PARENT])).rows[0];
    if (!par) { console.error(`❌ branch madre '${PARENT}' no existe — abortando`); process.exitCode = 1; return; }
    const wh = (await dst.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`, [M, par.wcode])).rows[0];
    if (!wh) { console.error(`❌ warehouse '${par.wcode}' no existe — abortando`); process.exitCode = 1; return; }

    // rollup mes desde el canal preventa_vecinal de la suc madre (tickets = consecutivos distintos)
    const roll = (await dst.query(
      `SELECT date_trunc('month', business_date)::date AS month,
              sum(qty)::numeric AS units, sum(importe)::numeric AS revenue,
              count(DISTINCT consecutivo)::int AS tickets
         FROM wincaja.v_sales_lines
        WHERE tenant_id=$1 AND source_branch=$2 AND sale_channel='preventa_vecinal' AND business_date < DATE '${CUTOVER}'
        GROUP BY 1 ORDER BY 1`, [M, PARENT])).rows;
    if (!roll.length) { console.log('sin venta vecinal histórica en Wincaja — nada que hacer.'); return; }

    const rev = roll.reduce((s, r) => s + Number(r.revenue || 0), 0);
    console.log(`  suc madre ${PARENT} (${par.branch_name}) → warehouse ${wh.code}`);
    console.log(`  rollup: ${roll.length} meses · $${Math.round(rev).toLocaleString()}`);
    for (const r of roll) console.log(`    ${r.month.toISOString().slice(0, 7)} · $${Math.round(Number(r.revenue)).toLocaleString()} · ${r.tickets} tickets`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);

    // 1) branch histórica (idempotente)
    await dst.query(
      `INSERT INTO wincaja.branches (tenant_id, source_branch, branch_name, is_route, parent_branch, warehouse_code, status, imported_at)
       VALUES ($1,$2,$3,true,$4,$5,'archived',now())
       ON CONFLICT (tenant_id, source_branch) DO UPDATE SET
         branch_name=EXCLUDED.branch_name, is_route=true, parent_branch=EXCLUDED.parent_branch, imported_at=now()`,
      [M, ROUTE, NAME, PARENT, `RUTA-${ROUTE}`]);

    // 2) rollup → sales_by_route_monthly (WIN-VEC-PH-H, GREATEST)
    for (const r of roll) {
      await dst.query(
        `INSERT INTO analytics.sales_by_route_monthly (tenant_id, warehouse_id, route_code, route_no, month, units, revenue, tickets)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, warehouse_id, route_code, month) DO UPDATE SET
           units   = GREATEST(analytics.sales_by_route_monthly.units,   EXCLUDED.units),
           revenue = GREATEST(analytics.sales_by_route_monthly.revenue, EXCLUDED.revenue),
           tickets = GREATEST(analytics.sales_by_route_monthly.tickets, EXCLUDED.tickets),
           route_no = COALESCE(EXCLUDED.route_no, analytics.sales_by_route_monthly.route_no), updated_at = now()`,
        [M, wh.id, `WIN-${ROUTE}`, ROUTE, r.month, r.units, r.revenue, r.tickets]);
    }

    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — branch ${ROUTE} registrada · ${roll.length} meses de rollup.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await dst.end().catch(() => {});
  }
})();
