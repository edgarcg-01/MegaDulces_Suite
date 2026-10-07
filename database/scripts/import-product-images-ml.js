/**
 * Importer: imágenes de producto desde Mercado Libre MX → Cloudinary.
 *
 * Complementa a OFF (Open Food Facts):
 *   - OFF cubre productos con barcode EAN/UPC válido + marca internacional
 *   - ML cubre productos regionales MX / sin barcode / dulces locales
 *
 * Default scope: productos SIN barcode válido (los que OFF no toca).
 * Pasarle --include-no-image-only para procesar TODOS los productos sin imagen
 * después de que OFF haya terminado (segunda pasada).
 *
 * Estrategia:
 *   1. Build query: brand + nombre (limpiado de prefijos genéricos "IND", "G ", etc.)
 *   2. GET https://api.mercadolibre.com/sites/MLM/search?q=...&limit=3
 *   3. Tomar primer resultado con thumbnail decente (size > 100x100)
 *   4. Download imagen + upload Cloudinary + update DB con image_source='ml'
 *   5. Si no encuentra: append a pending JSONL con razón
 *
 * ML API es más permisiva que OFF: ~1000 req/hour, no requiere auth.
 *
 * Uso:
 *   node database/scripts/import-product-images-ml.js                       # productos sin barcode válido
 *   node database/scripts/import-product-images-ml.js --include-no-image-only # TODOS sin imagen (post-OFF)
 *   node database/scripts/import-product-images-ml.js --limit=10 --dry-run
 *   node database/scripts/import-product-images-ml.js --rate=2
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
const INCLUDE_ALL = !!args['include-no-image-only'];
const RATE = args.rate ? Math.max(0.2, parseFloat(args.rate)) : 1;
const SLEEP_MS = Math.floor(1000 / RATE);

const PENDING_LOG = path.join(__dirname, '..', `image-import-ml-pending-${new Date().toISOString().slice(0, 10)}.jsonl`);
const RESULTS_LOG = path.join(__dirname, '..', `image-import-ml-results-${new Date().toISOString().slice(0, 10)}.jsonl`);

const UA = 'MegaDulcesCatalog/1.0 (desarrollador.dayan@megadulces.com.mx)';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchMlOnce(query) {
  const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encodeURIComponent(query)}&limit=5&condition=new`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000 }, (res) => {
      if (res.statusCode === 429) {
        res.resume();
        const err = new Error(`ML 429`);
        err._rateLimited = true;
        return reject(err);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`ML status ${res.statusCode} for "${query}"`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error(`ML non-JSON: ${e.message}`));
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('ML timeout')));
    req.on('error', reject);
  });
}

async function fetchMl(query) {
  const backoffs = [3000, 8000, 20000];
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fetchMlOnce(query);
    } catch (e) {
      if (!e._rateLimited || attempt === backoffs.length) throw e;
      console.log(`    ↻ 429 retry ${attempt + 1}/${backoffs.length} en ${backoffs[attempt]}ms`);
      await sleep(backoffs[attempt]);
    }
  }
}

// Limpia prefijos genéricos del nombre que ensucian la búsqueda
function cleanName(name) {
  return (name || '')
    .replace(/^IND\s+/i, '')
    .replace(/^G\s+INDIVIDUALES\s*/i, '')
    .replace(/^G\s+/, '')
    .replace(/\s*\/\s*\d+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBrand(brand) {
  if (!brand) return '';
  return brand
    .replace(/\s+S\.?A\.?\s+DE\s+C\.?V\.?\s*$/i, '')
    .replace(/\s+S\s+DE\s+R\.?L\s+DE\s+CV\s*$/i, '')
    .replace(/\s+INC\.?\s*$/i, '')
    .replace(/\s+MEXICO\s*$/i, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

function buildQuery(p) {
  const brand = cleanBrand(p.brand_name);
  const name = cleanName(p.nombre);
  return [brand, name].filter(Boolean).join(' ').slice(0, 100);
}

function pickBestPicture(item) {
  if (!item) return null;
  if (item.thumbnail && item.thumbnail.startsWith('http')) {
    return item.thumbnail.replace(/-I\.jpg$/, '-O.jpg').replace(/\/I\//, '/O/');
  }
  return null;
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

async function main() {
  console.log(`▶ Import imágenes Mercado Libre MX → Cloudinary`);
  console.log(`  tenant: ${TENANT_SLUG}`);
  console.log(`  scope: ${INCLUDE_ALL ? 'TODOS sin imagen' : 'sin barcode válido (complementario a OFF)'}`);
  console.log(`  limit: ${LIMIT === Infinity ? 'all' : LIMIT}`);
  console.log(`  rate: ${RATE} req/sec (sleep ${SLEEP_MS}ms)`);
  console.log(`  dry-run: ${DRY}`);
  console.log(`  force: ${FORCE}`);
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
    .whereNull('p.deleted_at');

  if (!FORCE) q.whereNull('p.image_url');

  if (!INCLUDE_ALL) {
    q.where(function () {
      this.whereNull('p.barcode')
        .orWhereRaw(`NOT (p.barcode ~ '^[0-9]+$')`)
        .orWhereRaw(`LENGTH(p.barcode) < 8`);
    });
  }

  const products = await q
    .select('p.id', 'p.sku', 'p.barcode', 'p.nombre', 'b.nombre as brand_name')
    .orderBy('p.sku', 'asc')
    .limit(LIMIT);

  console.log(`→ ${products.length} productos a procesar\n`);

  let hits = 0, miss = 0, errors = 0;
  const startedAt = Date.now();

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const query = buildQuery(p);
    const tag = `[${i + 1}/${products.length}] sku=${p.sku} "${query}"`;

    if (!query || query.length < 3) {
      miss++;
      appendJsonl(PENDING_LOG, { id: p.id, sku: p.sku, nombre: p.nombre, brand: p.brand_name, reason: 'query_too_short' });
      console.log(`${tag} ✗ query-empty`);
      continue;
    }

    try {
      const r = await fetchMl(query);
      const first = (r.results || [])[0];
      const pic = pickBestPicture(first);

      if (!first || !pic) {
        miss++;
        appendJsonl(PENDING_LOG, { id: p.id, sku: p.sku, nombre: p.nombre, brand: p.brand_name, query, reason: first ? 'no_picture' : 'no_results' });
        console.log(`${tag} ✗ ${first ? 'no-pic' : 'no-results'}`);
      } else if (DRY) {
        hits++;
        console.log(`${tag} ✓ DRY ${first.title?.slice(0, 50)} → ${pic}`);
        appendJsonl(RESULTS_LOG, { id: p.id, sku: p.sku, dry: true, ml_title: first.title, ml_url: pic });
      } else {
        const publicId = `${p.sku}`.replace(/[^A-Za-z0-9_-]/g, '_');
        const folder = `products/${TENANT_SLUG}`;
        const up = await uploadFromUrl({ url: pic, publicId, folder, tags: ['ml-import', first.id || ''] });

        const updated = await knex('products')
          .where({ id: p.id, tenant_id: TENANT_ID })
          .whereNull('image_url')
          .update({
            image_url: up.secure_url,
            image_source: 'ml',
            image_storage_key: up.public_id,
            image_updated_at: knex.fn.now(),
          });

        if (updated === 0) {
          appendJsonl(RESULTS_LOG, { id: p.id, sku: p.sku, skipped_by_race: true, ml_title: first.title });
          console.log(`${tag} ⊘ ya tenía imagen (race con OFF) — uploaded pero no UPDATE`);
        } else {
          hits++;
          appendJsonl(RESULTS_LOG, { id: p.id, sku: p.sku, secure_url: up.secure_url, public_id: up.public_id, ml_title: first.title, ml_id: first.id });
          console.log(`${tag} ✓ ${first.title?.slice(0, 50)}`);
        }
      }
    } catch (e) {
      errors++;
      const reason = e._rateLimited ? 'retry_later_429' : 'error';
      appendJsonl(PENDING_LOG, { id: p.id, sku: p.sku, nombre: p.nombre, brand: p.brand_name, query, reason, error: e.message });
      console.log(`${tag} ✗ ${e._rateLimited ? '429 (exhausted)' : 'ERR ' + e.message}`);
    }

    if (i < products.length - 1) await sleep(SLEEP_MS);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('');
  console.log(`▶ Resumen ML`);
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
