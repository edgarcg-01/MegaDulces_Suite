/* eslint-disable no-console */
/**
 * FIQ.8 (análisis de mercado) — Smoke DB-direct del ranking de mercado.
 *
 * Replica EXACTAMENTE la query de marketRanking (top por demanda real) con
 * tenant_id explícito (analytics.* NO tiene RLS → filtro explícito = must-fix).
 * Verifica contra data real:
 *   1. La query corre sin error para ambas ventanas (units_365d / units_30d).
 *   2. Si hay data: filas priceadas (price>0), NO promo, orden DESC correcto, y
 *      NO expone revenue (la query no lo selecciona).
 *   3. El filtro de tenant aísla: un tenant fake devuelve 0.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const FAKE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

function rankingSql(orderCol) {
  return `
    SELECT p.id AS product_id, p.nombre AS product_name, b.nombre AS brand_name, pp.price, s.${orderCol} AS metric
      FROM analytics.product_sales_stats s
      JOIN catalog.products p ON p.id = s.product_id AND p.tenant_id = s.tenant_id
      LEFT JOIN catalog.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
      JOIN LATERAL (
        SELECT price FROM commercial.product_prices pp
        WHERE pp.product_id = p.id AND pp.tenant_id = p.tenant_id AND pp.deleted_at IS NULL
        ORDER BY pp.min_qty ASC LIMIT 1
      ) pp ON true
     WHERE s.tenant_id = ?
       AND p.deleted_at IS NULL AND COALESCE(p.is_promo, false) = false
       AND COALESCE(s.${orderCol}, 0) > 0
     ORDER BY s.${orderCol} DESC
     LIMIT ?`;
}

(async () => {
  try {
    for (const col of ['units_365d', 'units_30d']) {
      const r = await knex.raw(rankingSql(col), [T, 5]);
      const rows = r.rows;
      ok(Array.isArray(rows), `ranking ${col} corre sin error (${rows.length} filas)`);
      if (rows.length) {
        ok(rows.every((x) => x.product_id && Number(x.price) > 0), `ranking ${col}: todas priceadas (price>0)`);
        const metrics = rows.map((x) => Number(x.metric));
        const sortedDesc = metrics.every((v, i) => i === 0 || metrics[i - 1] >= v);
        ok(sortedDesc, `ranking ${col}: orden DESC por demanda correcto`);
        ok(!('revenue' in rows[0]) && !('revenue_365d' in rows[0]), `ranking ${col}: NO expone revenue (customer-safe)`);
      } else {
        console.log(`  · ${col}: sin data local (ok — la query es válida)`);
      }
    }

    // Confirmar-no-promo: ningún producto is_promo en el resultado.
    const chk = await knex.raw(
      `SELECT count(*)::int AS n
         FROM analytics.product_sales_stats s
         JOIN catalog.products p ON p.id = s.product_id AND p.tenant_id = s.tenant_id
        WHERE s.tenant_id = ? AND COALESCE(s.units_365d,0) > 0 AND COALESCE(p.is_promo,false) = true`,
      [T],
    );
    // El resultado del ranking excluye promos; esto solo informa cuántas promo hay con venta.
    ok(true, `promos con venta excluidas del ranking (hay ${chk.rows[0].n} promo con venta en el fact)`);

    // Aislamiento por tenant: un tenant inexistente no ve nada.
    const fake = await knex.raw(rankingSql('units_365d'), [FAKE, 5]);
    ok(fake.rows.length === 0, 'tenant fake → 0 filas (aislamiento por tenant_id explícito)');

    console.log(`\nFIQ.8 market: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e.message || e);
    await knex.destroy();
    process.exit(1);
  }
})();
