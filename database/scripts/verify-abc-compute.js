/* eslint-disable no-console */
// ABC.0 — valida el SQL de clasificación (CTEs + window functions) READ-ONLY.
// El user del script bypassa RLS → filtro tenant explícito (en el servicio lo hace RLS).
//   node database/scripts/verify-abc-compute.js
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const WIN = 90;

(async () => {
  let ok = true;
  try {
    const { rows } = await knex.raw(
      `
      WITH sales AS (
        SELECT o.warehouse_id, l.product_id, SUM(l.quantity)::numeric AS units
          FROM commercial.orders o
          JOIN commercial.order_lines l ON l.order_id = o.id
         WHERE o.status = 'fulfilled' AND o.fulfilled_at >= now() - (? || ' days')::interval
           AND o.tenant_id = ?
         GROUP BY o.warehouse_id, l.product_id
      ),
      base AS (
        SELECT s.warehouse_id, s.product_id,
               COALESCE(sa.units, 0) AS units,
               (COALESCE(sa.units, 0) * (365.0 / ?) * COALESCE(cp.cost_base, 0))::numeric(16,2) AS annual_value
          FROM commercial.stock s
          JOIN catalog.products cp ON cp.id = s.product_id AND cp.tenant_id = ?
          LEFT JOIN sales sa ON sa.warehouse_id = s.warehouse_id AND sa.product_id = s.product_id
         WHERE s.tenant_id = ?
      ),
      ranked AS (
        SELECT warehouse_id, product_id, units, annual_value,
               SUM(annual_value) OVER (PARTITION BY warehouse_id ORDER BY annual_value DESC, product_id
                                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_value,
               NULLIF(SUM(annual_value) OVER (PARTITION BY warehouse_id), 0) AS total_value
          FROM base
      )
      SELECT CASE WHEN total_value IS NULL THEN 'C'
                  WHEN (cum_value - annual_value) / total_value < 0.80 THEN 'A'
                  WHEN (cum_value - annual_value) / total_value < 0.95 THEN 'B'
                  ELSE 'C' END AS abc_class,
             annual_value,
             CASE WHEN total_value IS NULL THEN 1.0 ELSE round(cum_value / total_value, 4) END AS value_share
        FROM ranked
      `,
      [WIN, MEGA, WIN, MEGA, MEGA],
    );

    const by = { A: 0, B: 0, C: 0 };
    let badClass = 0, badShare = 0;
    for (const r of rows) {
      if (!['A', 'B', 'C'].includes(r.abc_class)) badClass++;
      else by[r.abc_class]++;
      const sh = Number(r.value_share);
      if (sh < 0 || sh > 1.0001) badShare++;
    }
    console.log(`  Filas clasificadas: ${rows.length}`);
    console.log(`  Distribución: A=${by.A}  B=${by.B}  C=${by.C}`);
    const withVal = rows.filter((r) => Number(r.annual_value) > 0).length;
    console.log(`  Con valor de consumo > 0: ${withVal}`);
    if (badClass) { console.log(`  FAIL: ${badClass} filas con clase inválida`); ok = false; }
    if (badShare) { console.log(`  FAIL: ${badShare} filas con value_share fuera de [0,1]`); ok = false; }
    if (by.A + by.B + by.C !== rows.length) { console.log('  FAIL: suma de clases != total'); ok = false; }
    if (ok) console.log('  OK: toda fila tiene clase válida + value_share en [0,1]');
  } catch (e) {
    console.error('FATAL (SQL):', e.message);
    ok = false;
  }
  await knex.destroy();
  console.log(ok ? '\n✅ PASS (SQL válido)' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
})();
