#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Importer — popula `trade.planogram_skus` con todos los SKUs presentes en
 * `catalog.products` del tenant target.
 *
 * Caso de uso: arranque inicial del planograma de Mega Dulces — los 1199
 * productos ya curados en `catalog.products` de prod (resultado de
 * pre-incidente 2026-06-03) se promueven todos a planograma. Los administradores
 * de trade marketing podrán después desactivar / curar la lista vía UI.
 *
 * UPSERT por (tenant_id, sku): re-ejecutable. Si el SKU ya existe lo deja
 * intacto excepto product_id (lo re-linkea por si cambió). Solo agrega nuevos.
 *
 * Uso:
 *   node database/importers/planogram-skus-from-catalog.js --tenant-slug=mega_dulces [--dry-run]
 *
 * Variables opcionales:
 *   DATABASE_URL_NEW: override de connection string (default: knexfile dev)
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '..', '.env'),
});
const knexLib = require('knex');

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--tenant-slug=')) args.tenant_slug = a.split('=')[1];
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node database/importers/planogram-skus-from-catalog.js --tenant-slug=<slug> [--dry-run]

Popula trade.planogram_skus desde catalog.products del tenant.
- UPSERT por (tenant_id, sku) — idempotente.
- Skips productos con sku NULL.
- Asigna orden_exhibicion = ROW_NUMBER() OVER (ORDER BY sku) como default.
`);
}

async function setCtx(trx, tenantId) {
  await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();
  if (!args.tenant_slug) {
    console.error('ERROR: --tenant-slug requerido');
    printHelp();
    process.exit(1);
  }

  // Conexión: si DATABASE_URL_NEW está seteado lo usamos (override para
  // Railway prod), si no usamos el knexfile development.
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
    const tenant = await knex('identity.tenants')
      .where({ slug: args.tenant_slug, activo: true })
      .first();
    if (!tenant)
      throw new Error(
        `Tenant slug "${args.tenant_slug}" no encontrado o inactivo`,
      );
    console.log(
      `[planogram_skus] tenant: ${tenant.slug} (${tenant.id})`,
    );

    // Detectar si existe columna `articulo` (orphan column de Railway que tiene
    // los SKUs en data legacy mientras `sku` está NULL). En local NO existe.
    const hasArticulo = await knex.schema
      .withSchema('catalog')
      .hasColumn('products', 'articulo');
    const skuExpr = hasArticulo ? 'COALESCE(sku, articulo)' : 'sku';
    console.log(`[planogram_skus] sku source: ${skuExpr}`);

    const products = await knex('catalog.products')
      .where({ tenant_id: tenant.id })
      .whereNull('deleted_at')
      .select('id', knex.raw(`${skuExpr} as sku`))
      .whereRaw(`${skuExpr} IS NOT NULL`)
      .orderByRaw(skuExpr);

    console.log(
      `[planogram_skus] source: ${products.length} products en catalog.products`,
    );

    if (args.dryRun) {
      console.log(
        `[DRY RUN] Would upsert ${products.length} rows en trade.planogram_skus`,
      );
      return;
    }

    let inserted = 0;
    let skippedDup = 0;
    let orden = 0;

    await knex.transaction(async (trx) => {
      await setCtx(trx, tenant.id);

      for (const p of products) {
        orden++;
        const result = await trx.raw(
          `
          INSERT INTO trade.planogram_skus
            (tenant_id, product_id, sku, orden_exhibicion)
          VALUES (?, ?, ?, ?)
          ON CONFLICT DO NOTHING
          RETURNING id
          `,
          [tenant.id, p.id, p.sku, orden],
        );
        if (result.rows.length > 0) inserted++;
        else skippedDup++;
      }
    });

    console.log(
      `[planogram_skus] OK: inserted=${inserted} skipped_dup=${skippedDup} processed=${products.length}`,
    );
  } catch (e) {
    console.error('[planogram_skus] ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
}

main();
