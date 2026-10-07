/**
 * Importer: imágenes de producto desde Open Food Facts → Cloudinary.
 *
 * Estrategia:
 *   1. Query `products` con barcode IS NOT NULL AND image_url IS NULL AND deleted_at IS NULL
 *   2. Por cada barcode: GET https://world.openfoodfacts.org/api/v2/product/{barcode}.json
 *      - Respeta rate limit: 1 req/sec promedio (configurable)
 *      - User-Agent custom (requerido por OFF para acceso a API)
 *   3. Si OFF devuelve `status:1` y tiene `image_front_url` o `image_url`:
 *        - Descarga la imagen
 *        - Sube a Cloudinary: folder `products/{tenant_slug}`, public_id = SKU
 *        - Update row: image_url = secure_url, image_source='off', image_storage_key=public_id
 *   4. Si no encuentra: append a `database/image-import-pending.jsonl` con metadata
 *
 * Idempotente: skip productos que ya tienen image_url salvo --force.
 *
 * Uso:
 *   node database/scripts/import-product-images-off.js                  # corre todo
 *   node database/scripts/import-product-images-off.js --limit=10       # primeros 10
 *   node database/scripts/import-product-images-off.js --tenant=mega_dulces
 *   node database/scripts/import-product-images-off.js --dry-run        # no DB writes ni upload
 *   node database/scripts/import-product-images-off.js --force          # re-procesa productos con imagen
 *   node database/scripts/import-product-images-off.js --rate=2         # 2 req/sec a OFF (default 1)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const cfg = require('../knexfile-newdb');
const knex = require('knex')(cfg.development || cfg);
const { uploadFromUrl } = require('../lib/cloudinary-storage');

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
const FORCE = !!args.force;
const RATE = args.rate ? Math.max(0.2, parseFloat(args.rate)) : 1;
const SLEEP_MS = Math.floor(1000 / RATE);

const PENDING_LOG = path.join(__dirname, '..', `image-import-pending-${new Date().toISOString().slice(0, 10)}.jsonl`);
const RESULTS_LOG = path.join(__dirname, '..', `image-import-results-${new Date().toISOString().slice(0, 10)}.jsonl`);

const UA = 'MegaDulcesCatalog/1.0 (desarrollador.dayan@megadulces.com.mx)';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchOffJsonOnce(barcode) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=code,product_name,brands,image_url,image_front_url,image_small_url`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }, (res) => {
      if (res.statusCode === 404) {
        res.resume();
        return resolve({ status: 0, _httpStatus: 404 });
      }
      if (res.statusCode === 429) {
        res.resume();
        const err = new Error(`OFF 429 rate-limited for ${barcode}`);
        err._rateLimited = true;
        return reject(err);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`OFF status ${res.statusCode} for ${barcode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error(`OFF non-JSON for ${barcode}: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('OFF timeout')));
    req.on('error', reject);
  });
}

async function fetchOffJson(barcode) {
  const backoffs = [3000, 8000, 20000];
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fetchOffJsonOnce(barcode);
    } catch (e) {
      if (!e._rateLimited || attempt === backoffs.length) throw e;
      const wait = backoffs[attempt];
      console.log(`    ↻ 429 retry ${attempt + 1}/${backoffs.length} en ${wait}ms`);
      await sleep(wait);
    }
  }
}

function bestImageUrl(off) {
  const p = off?.product || {};
  return p.image_front_url || p.image_url || p.image_small_url || null;
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

async function main() {
  console.log(`▶ Import imágenes OFF → Cloudinary`);
  console.log(`  tenant: ${TENANT_SLUG}`);
  console.log(`  limit: ${LIMIT === Infinity ? 'all' : LIMIT}`);
  console.log(`  rate: ${RATE} req/sec (sleep ${SLEEP_MS}ms)`);
  console.log(`  dry-run: ${DRY}`);
  console.log(`  force: ${FORCE}`);
  console.log(`  pending log: ${PENDING_LOG}`);
  console.log(`  results log: ${RESULTS_LOG}`);
  console.log('');

  const tenantRow = await knex('tenants').where({ slug: TENANT_SLUG }).first('id');
  if (!tenantRow) {
    console.error(`✗ tenant ${TENANT_SLUG} not found`);
    process.exit(1);
  }
  const TENANT_ID = tenantRow.id;

  const q = knex('products as p')
    .leftJoin('brands as b', function () {
      this.on('b.tenant_id', '=', 'p.tenant_id').andOn('b.id', '=', 'p.brand_id');
    })
    .where('p.tenant_id', TENANT_ID)
    .whereNull('p.deleted_at')
    .whereNotNull('p.barcode')
    .whereRaw(`p.barcode ~ '^[0-9]+$'`)
    .whereRaw(`LENGTH(p.barcode) >= 8`);

  if (!FORCE) q.whereNull('p.image_url');

  const products = await q
    .select('p.id', 'p.sku', 'p.barcode', 'p.nombre', 'b.nombre as brand_name')
    .orderBy('p.sku', 'asc')
    .limit(LIMIT);

  console.log(`→ ${products.length} productos a procesar\n`);

  let hits = 0, miss = 0, errors = 0;
  const startedAt = Date.now();

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const tag = `[${i + 1}/${products.length}] sku=${p.sku} barcode=${p.barcode}`;
    try {
      const off = await fetchOffJson(p.barcode);

      if (off.status !== 1) {
        miss++;
        appendJsonl(PENDING_LOG, { id: p.id, sku: p.sku, barcode: p.barcode, nombre: p.nombre, brand: p.brand_name, reason: 'not_found_off' });
        console.log(`${tag} ✗ not-found`);
      } else {
        const imgUrl = bestImageUrl(off);
        if (!imgUrl) {
          miss++;
          appendJsonl(PENDING_LOG, { id: p.id, sku: p.sku, barcode: p.barcode, nombre: p.nombre, brand: p.brand_name, reason: 'no_image_in_off', off_name: off.product?.product_name });
          console.log(`${tag} ✗ off-no-image (${off.product?.product_name || ''})`);
        } else if (DRY) {
          hits++;
          console.log(`${tag} ✓ DRY would-upload ${imgUrl}`);
          appendJsonl(RESULTS_LOG, { id: p.id, sku: p.sku, dry: true, would_upload: imgUrl });
        } else {
          const publicId = `${p.sku}`.replace(/[^A-Za-z0-9_-]/g, '_');
          const folder = `products/${TENANT_SLUG}`;
          const up = await uploadFromUrl({ url: imgUrl, publicId, folder, tags: ['off-import', p.barcode] });
          await knex('products')
            .where({ id: p.id, tenant_id: TENANT_ID })
            .update({
              image_url: up.secure_url,
              image_source: 'off',
              image_storage_key: up.public_id,
              image_updated_at: knex.fn.now(),
            });
          hits++;
          appendJsonl(RESULTS_LOG, { id: p.id, sku: p.sku, secure_url: up.secure_url, public_id: up.public_id, off_image: imgUrl, off_name: off.product?.product_name });
          console.log(`${tag} ✓ uploaded`);
        }
      }
    } catch (e) {
      errors++;
      const reason = e._rateLimited ? 'retry_later_429' : 'error';
      appendJsonl(PENDING_LOG, { id: p.id, sku: p.sku, barcode: p.barcode, nombre: p.nombre, brand: p.brand_name, reason, error: e.message });
      console.log(`${tag} ✗ ${e._rateLimited ? '429 (retry-exhausted)' : 'ERR ' + e.message}`);
    }
    if (i < products.length - 1) await sleep(SLEEP_MS);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log(`▶ Resumen`);
  console.log(`  hits:   ${hits}`);
  console.log(`  miss:   ${miss}`);
  console.log(`  errors: ${errors}`);
  console.log(`  total:  ${products.length}`);
  console.log(`  hit %:  ${products.length ? ((hits / products.length) * 100).toFixed(1) : 0}%`);
  console.log(`  elapsed:${elapsed}s`);
  await knex.destroy();
}

main().catch((e) => {
  console.error('✗ fatal:', e);
  knex.destroy();
  process.exit(1);
});
