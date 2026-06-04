#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Sube las imágenes de productos a Cloudinary y actualiza
 * `inventory.products.image_url` con la URL retornada.
 *
 * Convención:
 *   - filename (sin extensión) = SKU del producto
 *   - public_id en Cloudinary: `mega_dulces/products/{sku}`
 *   - folder: `mega_dulces/products`
 *
 * Idempotente: usa `overwrite: true` en Cloudinary. Re-ejecutable.
 *
 * Sincroniza la URL en LOCAL + RAILWAY (el `--target` controla cuál).
 *
 * Uso:
 *   node database/scripts/upload-product-images-to-cloudinary.js \
 *     --dir="Fotos de productos" --target=local [--dry-run]
 *
 *   --target=both → sube a Cloudinary una sola vez, hace UPDATE en ambas DBs
 *   --target=local|railway → sube + update solo en esa DB
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '..', '.env'),
});
const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const knexLib = require('knex');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function parseArgs(argv) {
  const args = { target: 'both' };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--dir=')) args.dir = a.split('=')[1];
    else if (a.startsWith('--target=')) args.target = a.split('=')[1];
  }
  return args;
}

function buildKnex(url) {
  return knexLib({
    client: 'pg',
    connection: url.includes('rlwy.net')
      ? { connectionString: url, ssl: { rejectUnauthorized: false } }
      : { connectionString: url },
    pool: { min: 1, max: 3 },
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.dir) {
    console.log('Usage: see header');
    process.exit(args.help ? 0 : 1);
  }

  const dir = path.resolve(__dirname, '..', '..', args.dir);
  if (!fs.existsSync(dir)) {
    console.error(`ERROR: dir not found: ${dir}`);
    process.exit(1);
  }

  // Listar .jpg + .png + .webp
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
  console.log(`[upload] dir: ${dir} (${files.length} images)`);

  // Setup knex connections según target
  const local = ['local', 'both'].includes(args.target)
    ? buildKnex('postgresql://postgres:superoot@localhost:5433/postgres_platform')
    : null;
  const railway = ['railway', 'both'].includes(args.target)
    ? buildKnex(
        'postgresql://postgres:whhQQTskVhAeQbbStUUkalNyWmikxBHJ@trolley.proxy.rlwy.net:39023/railway',
      )
    : null;

  // Pre-flight: verificar SKUs que existen en inventory.products
  const skus = files.map((f) => path.parse(f).name);
  const checkKnex = local || railway;
  const existing = await checkKnex('inventory.products').whereIn('sku', skus).pluck('sku');
  const existingSet = new Set(existing);
  console.log(`[upload] SKUs match en inventory.products: ${existingSet.size}/${skus.length}`);

  const missing = skus.filter((s) => !existingSet.has(s));
  if (missing.length > 0) {
    console.log(`[upload] WARN: ${missing.length} SKUs sin match — se saltan:`);
    console.log(`         ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` (+ ${missing.length - 10})` : ''}`);
  }

  if (args.dryRun) {
    console.log(
      `[DRY RUN] Subiría ${existingSet.size} imágenes a Cloudinary + UPDATE en ${args.target}`,
    );
    return;
  }

  // Upload + update
  let uploaded = 0;
  let updated = 0;
  let failed = 0;
  const startTotal = Date.now();

  for (const file of files) {
    const sku = path.parse(file).name;
    if (!existingSet.has(sku)) continue;

    const filePath = path.join(dir, file);
    const publicId = `mega_dulces/products/${sku}`;

    try {
      const result = await cloudinary.uploader.upload(filePath, {
        public_id: publicId,
        folder: 'mega_dulces/products',
        overwrite: true,
        resource_type: 'image',
        // Optimización default
        quality: 'auto:good',
      });
      uploaded++;

      const url = result.secure_url;
      const storageKey = result.public_id;

      // UPDATE en cada target DB
      for (const k of [local, railway].filter(Boolean)) {
        await k('inventory.products')
          .where({ sku })
          .update({
            image_url: url,
            image_source: 'cloudinary',
            image_storage_key: storageKey,
            image_updated_at: k.fn.now(),
          });
      }
      updated++;

      if (uploaded % 10 === 0) {
        console.log(
          `[upload] progress: ${uploaded}/${existingSet.size} (${Math.round(((Date.now() - startTotal) / 1000) * 10) / 10}s)`,
        );
      }
    } catch (e) {
      failed++;
      console.error(`[upload] FAIL ${sku}: ${e.message}`);
    }
  }

  const totalSec = Math.round((Date.now() - startTotal) / 100) / 10;
  console.log(
    `[upload] OK (${totalSec}s): uploaded=${uploaded} db_updated=${updated} failed=${failed}`,
  );

  if (local) await local.destroy();
  if (railway) await railway.destroy();
}

main().catch((e) => {
  console.error('[upload] ERROR:', e);
  process.exit(1);
});
