"use strict";
/**
 * READ-ONLY: cuántos productos "usa" el catálogo del vendedor.
 * El catálogo del vendedor (catalogForCustomer → listPrices priced_only) =
 * productos de catalog.products (activos) CON precio en la price list aplicable.
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/diag-catalog-prod.js
 */
const { Client } = require('pg');
const URL = process.env.PROD_DATABASE_URL;
if (!URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const totProd = await c.query(`SELECT count(*)::int n FROM catalog.products WHERE deleted_at IS NULL`);
  console.log(`Catálogo total (catalog.products activos): ${totProd.rows[0].n}`);

  const totPrices = await c.query(
    `SELECT count(*)::int n FROM commercial.product_prices WHERE deleted_at IS NULL AND price IS NOT NULL`);
  console.log(`product_prices con precio (todas las listas): ${totPrices.rows[0].n}`);

  // Productos PEDIBLES por price list = lo que ve el vendedor con esa lista (priced_only)
  const perList = await c.query(`
    SELECT pl.code, pl.is_default,
      (SELECT count(*)::int
         FROM commercial.product_prices pp
         JOIN catalog.products p ON p.id = pp.product_id AND p.tenant_id = pp.tenant_id AND p.deleted_at IS NULL
        WHERE pp.price_list_id = pl.id AND pp.deleted_at IS NULL AND pp.price IS NOT NULL
      ) AS productos_catalogo
    FROM commercial.price_lists pl
    WHERE pl.deleted_at IS NULL
    ORDER BY pl.is_default DESC, pl.code`);
  console.log('\nProductos pedibles por price list (catálogo que ve el vendedor):');
  console.table(perList.rows);

  await c.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
