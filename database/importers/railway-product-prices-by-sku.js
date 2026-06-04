#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Importer — popula `commercial.product_prices` en Railway prod mapeando
 * desde un CSV `sku,price,tax_rate,min_qty` (exportado desde local con
 * los precios de Nivel 1).
 *
 * El mapping es por SKU: para cada row del CSV, busca en Railway el
 * `catalog.products` con `COALESCE(sku, articulo) = csv.sku` y agarra ese
 * `product_id`. Luego inserta en `commercial.product_prices` con
 * `price_list_id = BASE-MXN` (el único que existe en Railway prod).
 *
 * Idempotente: ON CONFLICT (tenant_id, product_id, price_list_id) DO NOTHING.
 *
 * Uso:
 *   DATABASE_URL_NEW=postgresql://...@trolley...:39023/railway \
 *     node database/importers/railway-product-prices-by-sku.js \
 *       --csv=database/backups/sync-csv/local-p1-prices-by-sku.csv \
 *       --price-list-id=00000000-0000-0000-0000-0000c0ffee02 \
 *       --tenant-id=00000000-0000-0000-0000-00000000d01c \
 *       [--dry-run]
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '..', '.env'),
});
const fs = require('fs');
const knexLib = require('knex');

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--csv=')) args.csv = a.split('=')[1];
    else if (a.startsWith('--price-list-id=')) args.priceListId = a.split('=')[1];
    else if (a.startsWith('--tenant-id=')) args.tenantId = a.split('=')[1];
  }
  return args;
}

function parseCsv(path) {
  const lines = fs.readFileSync(path, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => (row[h] = cols[idx]));
    rows.push(row);
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: see file header');
    return;
  }
  if (!args.csv || !args.priceListId || !args.tenantId) {
    console.error('ERROR: --csv, --price-list-id y --tenant-id requeridos');
    process.exit(1);
  }

  const rows = parseCsv(args.csv);
  console.log(`[prices_sync] CSV: ${rows.length} rows`);

  let knexCfg;
  if (process.env.DATABASE_URL_NEW) {
    knexCfg = {
      client: 'pg',
      connection: process.env.DATABASE_URL_NEW.includes('rlwy.net')
        ? {
            connectionString: process.env.DATABASE_URL_NEW,
            ssl: { rejectUnauthorized: false },
          }
        : { connectionString: process.env.DATABASE_URL_NEW },
      pool: { min: 1, max: 5 },
    };
  } else {
    knexCfg = require('../knexfile-newdb.js').development;
  }

  const knex = knexLib(knexCfg);

  try {
    // Detectar si Railway tiene la column `articulo` (orphan del schema drift)
    const hasArticulo = await knex.schema
      .withSchema('catalog')
      .hasColumn('products', 'articulo');
    console.log(
      `[prices_sync] articulo column exists: ${hasArticulo} (mapping by ${hasArticulo ? 'COALESCE(sku, articulo)' : 'sku'})`,
    );

    // Cargar mapping SKU → product_id desde Railway
    const skuExpr = hasArticulo ? 'COALESCE(sku, articulo)' : 'sku';
    const products = await knex('catalog.products')
      .where({ tenant_id: args.tenantId })
      .whereNull('deleted_at')
      .select('id', knex.raw(`${skuExpr} as effective_sku`))
      .whereRaw(`${skuExpr} IS NOT NULL`);

    const productMap = new Map();
    for (const p of products) {
      // Si hay duplicados de articulo, el primero gana (no debería pasar en prod
      // porque tenemos 869 distinct articulos para 905 con articulo no-null —
      // los duplicados sí existen). UPSERT DO NOTHING los maneja.
      if (!productMap.has(p.effective_sku)) {
        productMap.set(p.effective_sku, p.id);
      }
    }
    console.log(
      `[prices_sync] Railway: ${products.length} products, ${productMap.size} SKUs únicos`,
    );

    // Verificar cuántos del CSV matchean
    let matched = 0;
    let notMatched = 0;
    for (const row of rows) {
      if (productMap.has(row.sku)) matched++;
      else notMatched++;
    }
    console.log(
      `[prices_sync] CSV matching: ${matched} match con Railway, ${notMatched} sin match`,
    );

    if (args.dryRun) {
      console.log(`[DRY RUN] Insertaría hasta ${matched} rows en commercial.product_prices`);
      return;
    }

    // INSERT por batch (ON CONFLICT DO NOTHING)
    let inserted = 0;
    let conflict = 0;
    let skipped = 0;

    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${args.tenantId}'`);

      for (const row of rows) {
        const productId = productMap.get(row.sku);
        if (!productId) {
          skipped++;
          continue;
        }
        const result = await trx.raw(
          `
          INSERT INTO commercial.product_prices
            (tenant_id, product_id, price_list_id, price, tax_rate, min_qty)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, product_id, price_list_id) DO NOTHING
          RETURNING id
          `,
          [
            args.tenantId,
            productId,
            args.priceListId,
            row.price,
            row.tax_rate,
            row.min_qty,
          ],
        );
        if (result.rows.length > 0) inserted++;
        else conflict++;
      }
    });

    console.log(
      `[prices_sync] OK: inserted=${inserted} conflict=${conflict} no_match_in_railway=${skipped}`,
    );
  } catch (e) {
    console.error('[prices_sync] ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
}

main();
