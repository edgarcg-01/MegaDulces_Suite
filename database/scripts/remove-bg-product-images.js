/**
 * Post-procesador: aplica background removal AI (BRIA RMBG-1.4 via
 * @imgly/background-removal-node) a las imágenes ya subidas en Cloudinary.
 *
 * Flujo:
 *   1. Query productos con image_url IS NOT NULL AND image_source IN ('off','ml','google')
 *      AND image_storage_key NOT LIKE '%-bg' (no procesados aún)
 *   2. Descargar imagen de Cloudinary (URL pública)
 *   3. removeBackground(buffer) → PNG transparente
 *   4. Re-upload Cloudinary con folder `products-bg/{tenant_slug}/{sku}` + format png
 *   5. Update DB: image_url = nueva URL, image_storage_key = nuevo public_id (sufijo -bg)
 *
 * Idempotente: skip productos con image_storage_key terminado en `-bg`.
 *
 * Performance: ~5-8s/imagen en CPU. Para 2000 imágenes = ~3h sequential.
 * Modelo bajo demanda (~30MB) cacheado en ~/.cache.
 *
 * Uso:
 *   node database/scripts/remove-bg-product-images.js                   # todo
 *   node database/scripts/remove-bg-product-images.js --limit=5         # smoke
 *   node database/scripts/remove-bg-product-images.js --dry-run         # no upload/update
 *   node database/scripts/remove-bg-product-images.js --tenant=mega_dulces
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const cfg = require('../knexfile-newdb');
const knex = require('knex')(cfg.development || cfg);
const cloudinary = require('cloudinary').v2;
const { removeBackground } = require('@imgly/background-removal-node');

cloudinary.config({ secure: true });

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) return [a, true];
    return [m[1], m[2] === undefined ? true : m[2]];
  })
);

const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const TENANT_SLUG = args.tenant || 'mega_dulces';
const DRY = !!args['dry-run'];

const RESULTS_LOG = path.join(__dirname, '..', `image-bg-results-${new Date().toISOString().slice(0, 10)}.jsonl`);
const FAIL_LOG = path.join(__dirname, '..', `image-bg-fail-${new Date().toISOString().slice(0, 10)}.jsonl`);

function fetchImage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'image/jpeg,image/png' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`fetch ${res.statusCode} for ${url}`));
      }
      const ct = res.headers['content-type'] || 'image/jpeg';
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: ct }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function uploadPng(buffer, publicId, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        folder,
        resource_type: 'image',
        format: 'png',
        overwrite: true,
        tags: ['bg-removed'],
        transformation: [{ width: 800, height: 800, crop: 'limit', quality: 'auto:best', fetch_format: 'png' }],
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

async function main() {
  console.log(`▶ Background removal AI → PNG transparente`);
  console.log(`  tenant: ${TENANT_SLUG}`);
  console.log(`  limit: ${LIMIT === Infinity ? 'all' : LIMIT}`);
  console.log(`  dry-run: ${DRY}`);
  console.log('');

  const tenantRow = await knex('tenants').where({ slug: TENANT_SLUG }).first('id');
  if (!tenantRow) {
    console.error(`✗ tenant ${TENANT_SLUG} not found`);
    process.exit(1);
  }
  const TENANT_ID = tenantRow.id;

  const products = await knex('products')
    .where('tenant_id', TENANT_ID)
    .whereNull('deleted_at')
    .whereNotNull('image_url')
    .whereIn('image_source', ['off', 'ml', 'google'])
    .where(function () {
      this.whereNull('image_storage_key').orWhereRaw(`image_storage_key NOT LIKE '%-bg'`);
    })
    .select('id', 'sku', 'nombre', 'image_url', 'image_storage_key')
    .orderBy('image_updated_at', 'asc')
    .limit(LIMIT);

  console.log(`→ ${products.length} productos a procesar (CPU: ~5-8s c/u)\n`);

  let ok = 0, fail = 0;
  const startedAt = Date.now();

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const tag = `[${i + 1}/${products.length}] sku=${p.sku}`;
    const t0 = Date.now();

    try {
      const { buffer: inputBuffer, contentType } = await fetchImage(p.image_url);
      const inputBlob = new Blob([inputBuffer], { type: contentType });
      const outputBlob = await removeBackground(inputBlob);
      const outBuffer = Buffer.from(await outputBlob.arrayBuffer());

      if (DRY) {
        ok++;
        console.log(`${tag} ✓ DRY ${(outBuffer.length / 1024).toFixed(0)}KB en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } else {
        const publicId = `${p.sku}-bg`.replace(/[^A-Za-z0-9_-]/g, '_');
        const folder = `products-bg/${TENANT_SLUG}`;
        const up = await uploadPng(outBuffer, publicId, folder);

        await knex('products')
          .where({ id: p.id, tenant_id: TENANT_ID })
          .update({
            image_url: up.secure_url,
            image_storage_key: up.public_id,
            image_updated_at: knex.fn.now(),
          });

        ok++;
        appendJsonl(RESULTS_LOG, { id: p.id, sku: p.sku, secure_url: up.secure_url, public_id: up.public_id });
        console.log(`${tag} ✓ ${((Date.now() - t0) / 1000).toFixed(1)}s → ${up.secure_url}`);
      }
    } catch (e) {
      fail++;
      appendJsonl(FAIL_LOG, { id: p.id, sku: p.sku, image_url: p.image_url, error: e.message });
      console.log(`${tag} ✗ ${e.message}`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log(`▶ Resumen BG removal`);
  console.log(`  ok:    ${ok}`);
  console.log(`  fail:  ${fail}`);
  console.log(`  total: ${products.length}`);
  console.log(`  avg:   ${products.length ? (parseFloat(elapsed) / products.length).toFixed(1) : 0}s/img`);
  console.log(`  total: ${elapsed}s`);
  await knex.destroy();
}

main().catch((e) => {
  console.error('✗ fatal:', e);
  knex.destroy();
  process.exit(1);
});
