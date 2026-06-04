#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Importer — popula `commercial.stock` en Railway prod desde CSV con
 * `sku, warehouse_code, quantity, reserved_quantity`. Mapea:
 *   - sku → Railway product_id via COALESCE(sku, articulo)
 *   - warehouse_code → Railway warehouse_id
 *
 * Idempotente: ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
 * actualiza la quantity (refresh de stock al estado del CSV).
 *
 * Uso:
 *   DATABASE_URL_NEW=... \
 *     node database/importers/railway-stock-by-sku.js \
 *       --csv=database/backups/sync-csv/local-stock-allwh-by-sku.csv \
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
    else if (a.startsWith('--csv=')) args.csv = a.split('=')[1];
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
  if (!args.csv || !args.tenantId) {
    console.error('ERROR: --csv y --tenant-id requeridos');
    process.exit(1);
  }

  const rows = parseCsv(args.csv);
  console.log(`[stock_sync] CSV: ${rows.length} rows`);

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
    const hasArticulo = await knex.schema
      .withSchema('catalog')
      .hasColumn('products', 'articulo');
    const skuExpr = hasArticulo ? 'COALESCE(sku, articulo)' : 'sku';

    // Cargar mapping sku → product_id
    const products = await knex('catalog.products')
      .where({ tenant_id: args.tenantId })
      .whereNull('deleted_at')
      .select('id', knex.raw(`${skuExpr} as effective_sku`))
      .whereRaw(`${skuExpr} IS NOT NULL`);
    const productMap = new Map();
    for (const p of products) {
      if (!productMap.has(p.effective_sku)) {
        productMap.set(p.effective_sku, p.id);
      }
    }

    // Cargar mapping warehouse_code → id
    const warehouses = await knex('commercial.warehouses')
      .where({ tenant_id: args.tenantId })
      .select('id', 'code');
    const warehouseMap = new Map(warehouses.map((w) => [w.code, w.id]));

    console.log(
      `[stock_sync] Railway: ${products.length} products / ${productMap.size} SKUs, ${warehouses.length} warehouses`,
    );

    // Pre-flight match counts
    let matchedRows = 0;
    let noProductMatch = 0;
    let noWarehouseMatch = 0;
    for (const r of rows) {
      const pid = productMap.get(r.sku);
      const wid = warehouseMap.get(r.warehouse_code);
      if (pid && wid) matchedRows++;
      else if (!pid) noProductMatch++;
      else if (!wid) noWarehouseMatch++;
    }
    console.log(
      `[stock_sync] preflight: match=${matchedRows} no_product=${noProductMatch} no_warehouse=${noWarehouseMatch}`,
    );

    if (args.dryRun) {
      console.log(`[DRY RUN] insertaría/upserteo ${matchedRows} rows`);
      return;
    }

    let inserted = 0;
    let updated = 0;
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${args.tenantId}'`);
      for (const r of rows) {
        const productId = productMap.get(r.sku);
        const warehouseId = warehouseMap.get(r.warehouse_code);
        if (!productId || !warehouseId) continue;
        const result = await trx.raw(
          `
          INSERT INTO commercial.stock
            (tenant_id, warehouse_id, product_id, quantity, reserved_quantity)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
            SET quantity = EXCLUDED.quantity,
                reserved_quantity = EXCLUDED.reserved_quantity,
                updated_at = now()
          RETURNING (xmax = 0) AS inserted
          `,
          [
            args.tenantId,
            warehouseId,
            productId,
            r.quantity,
            r.reserved_quantity,
          ],
        );
        if (result.rows[0]?.inserted) inserted++;
        else updated++;
      }
    });

    console.log(`[stock_sync] OK: inserted=${inserted} updated=${updated}`);
  } catch (e) {
    console.error('[stock_sync] ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
}

main();
