const knex = require('knex');
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL || 'postgresql://postgres:superoot@localhost:5433/postgres_platform', pool: { min: 1, max: 2 } });
(async () => {
  try {
    const PRICE_LIST_ID = '00000000-0000-0000-0000-0000c0ffee02';
    const WAREHOUSE_ID = '00000000-0000-0000-0000-0000c0ffee01';

    console.log(`▶ Price list ${PRICE_LIST_ID}`);
    const pl = await db('commercial.price_lists').where({ id: PRICE_LIST_ID }).first();
    console.log(pl ? `  ✓ existe: ${pl.code} - ${pl.name} (tenant=${pl.tenant_id})` : '  ✗ NO existe');

    console.log(`\n▶ Warehouse ${WAREHOUSE_ID}`);
    const wh = await db('commercial.warehouses').where({ id: WAREHOUSE_ID }).first();
    console.log(wh ? `  ✓ existe: ${wh.code} - ${wh.name}` : '  ✗ NO existe');

    console.log(`\n▶ Prices en este price_list`);
    const count = await db('commercial.product_prices').where({ price_list_id: PRICE_LIST_ID }).whereNull('deleted_at').count('* as c').first();
    console.log(`  Total: ${count.c}`);

    if (Number(count.c) > 0) {
      const sample = await db('commercial.product_prices as pp')
        .leftJoin('public.products as p', function() {
          this.on('p.id', '=', 'pp.product_id').andOn('p.tenant_id', '=', 'pp.tenant_id');
        })
        .leftJoin('public.brands as b', function() {
          this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
        })
        .where({ 'pp.price_list_id': PRICE_LIST_ID })
        .whereNull('pp.deleted_at')
        .limit(5)
        .select('pp.product_id', 'p.nombre as product_name', 'b.nombre as brand_name', 'pp.price');
      console.log('  Samples:');
      for (const r of sample) console.log(`    ${r.product_id.slice(0,8)}…  [${r.brand_name || '—'}]  "${r.product_name}"  $${r.price}`);
    }

    console.log(`\n▶ Probando el SQL exacto del endpoint (con warehouse_id)`);
    try {
      const result = await db.raw(`
        SELECT
          pp.id, pp.product_id, p.nombre AS product_name,
          p.brand_id, b.nombre AS brand_name,
          pp.price, pp.tax_rate, pp.min_qty,
          CASE WHEN s.id IS NULL THEN NULL ELSE GREATEST(s.quantity - COALESCE(s.reserved_quantity, 0), 0) END AS stock_available
        FROM commercial.product_prices pp
        LEFT JOIN public.products p ON p.id = pp.product_id AND p.tenant_id = pp.tenant_id
        LEFT JOIN public.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
        LEFT JOIN commercial.stock s ON s.product_id = pp.product_id AND s.tenant_id = pp.tenant_id AND s.warehouse_id = ?
        WHERE pp.deleted_at IS NULL AND pp.price_list_id = ?
        ORDER BY p.nombre ASC
        LIMIT 3
      `, [WAREHOUSE_ID, PRICE_LIST_ID]);
      console.log(`  ✓ Query OK, rows: ${result.rows.length}`);
      for (const r of result.rows) console.log(`    ${r.product_id.slice(0,8)}… "${r.product_name}" stock=${r.stock_available}`);
    } catch (e) {
      console.log(`  ✗ Query falla: ${e.message}`);
    }
  } finally { await db.destroy(); }
})();
