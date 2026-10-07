#!/usr/bin/env node
/**
 * Backfill de embeddings para `products` (Fase K — AI product match).
 *
 * Lee products activos cuyo `embedding IS NULL` (o todos si `--force`),
 * compone el `embedding_source_text` como "MARCA — NOMBRE", llama Voyage AI
 * `voyage-3` en batches y persiste el vector + source_text + updated_at.
 *
 * Idempotente: por default skip filas que ya tienen embedding.
 *
 * Flags:
 *   --force       Re-embed todos los products activos (sobrescribe existentes).
 *   --limit N     Procesar solo las primeras N filas pendientes.
 *   --dry-run     Calcular embeddings pero NO persistir (sirve para probar la
 *                 conexión con Voyage sin tocar la DB).
 *
 * Requiere en .env:
 *   - DATABASE_URL (host de la DB con products)
 *   - VOYAGE_API_KEY (https://dash.voyageai.com)
 *   - VOYAGE_EMBED_MODEL (default 'voyage-3')
 *
 * Ejecución:
 *   node database/scripts/backfill-product-embeddings.js
 *   node database/scripts/backfill-product-embeddings.js --limit 50 --dry-run
 *   node database/scripts/backfill-product-embeddings.js --force
 */

require('dotenv').config();
const knexLib = require('knex');

const VOYAGE_BASE = 'https://api.voyageai.com/v1/embeddings';
const MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-3';
const API_KEY = process.env.VOYAGE_API_KEY;
const BATCH_SIZE = 100; // Voyage acepta hasta 128 inputs por request.
const EXPECTED_DIMS = 1024;

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { force: false, limit: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--limit') opts.limit = Number(argv[++i]);
  }
  return opts;
}

function buildSourceText(brandName, productName) {
  // Voyage maneja español MX bien. Lowercase + trim asegura input estable
  // entre updates. Mantenemos guion em como separador (más raro de aparecer
  // en nombres reales que coma o pipe).
  const brand = (brandName || '').trim();
  const product = (productName || '').trim();
  if (!brand) return product;
  if (!product) return brand;
  return `${brand} — ${product}`;
}

async function embedBatch(texts, attempt = 1) {
  const res = await fetch(VOYAGE_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: 'document', // corpus indexing — Voyage internamente optimiza.
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Backoff exponencial en 429/5xx, max 3 intentos.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const waitMs = 1000 * Math.pow(2, attempt);
      console.warn(`  [voyage] ${res.status} retry in ${waitMs}ms (intento ${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, waitMs));
      return embedBatch(texts, attempt + 1);
    }
    throw new Error(`Voyage API ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = await res.json();
  // Voyage devuelve `data` ordenado por `index` ya, pero sorteamos defensive.
  return json.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function main() {
  if (!API_KEY) {
    console.error('Falta VOYAGE_API_KEY en .env. Abortando.');
    process.exit(1);
  }

  const opts = parseArgs();
  console.log('[backfill] config:', { model: MODEL, batchSize: BATCH_SIZE, ...opts });

  const knex = knexLib({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    pool: { min: 1, max: 3 },
  });

  try {
    // Query: products activos. Si --force también incluye los que ya tienen
    // embedding. Joineamos brands para componer el source_text.
    const baseQuery = knex('products as p')
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .where('p.activo', true)
      .select('p.id', 'p.nombre as product_name', 'b.nombre as brand_name');

    if (!opts.force) baseQuery.whereNull('p.embedding');
    if (opts.limit) baseQuery.limit(opts.limit);

    const rows = await baseQuery;
    console.log(`[backfill] candidatos: ${rows.length}`);
    if (rows.length === 0) {
      console.log('[backfill] nada para procesar. Salida limpia.');
      return;
    }

    let processed = 0;
    let embeddedOk = 0;
    let failed = 0;
    const t0 = Date.now();

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const texts = batch.map((r) => buildSourceText(r.brand_name, r.product_name));

      let embeddings;
      try {
        embeddings = await embedBatch(texts);
      } catch (e) {
        failed += batch.length;
        console.error(`  [batch ${i}/${rows.length}] FALLO:`, e.message);
        continue;
      }

      // Sanity check de dimensiones (Voyage podría cambiar el default).
      if (embeddings[0].length !== EXPECTED_DIMS) {
        throw new Error(
          `Voyage devolvió embeddings de dim ${embeddings[0].length}, ` +
            `esperado ${EXPECTED_DIMS}. Verificar VOYAGE_EMBED_MODEL.`,
        );
      }

      if (!opts.dryRun) {
        // Update por trx para que falla parcial no deje rows inconsistentes
        // (algunos con vector, otros sin source_text actualizado).
        await knex.transaction(async (trx) => {
          for (let j = 0; j < batch.length; j++) {
            const row = batch[j];
            const vec = embeddings[j];
            const src = texts[j];
            // pgvector acepta el literal `[1,2,3,...]` en texto.
            const vecLiteral = `[${vec.join(',')}]`;
            await trx('products').where({ id: row.id }).update({
              embedding: trx.raw('?::vector', [vecLiteral]),
              embedding_source_text: src,
              embedding_updated_at: trx.fn.now(),
            });
          }
        });
      }

      processed += batch.length;
      embeddedOk += batch.length;
      const pct = ((processed / rows.length) * 100).toFixed(1);
      console.log(`  [batch] ${processed}/${rows.length} (${pct}%) ok`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[backfill] DONE in ${elapsed}s — processed:${processed} ok:${embeddedOk} failed:${failed} dry_run:${opts.dryRun}`,
    );

    if (!opts.dryRun) {
      const verify = await knex('products')
        .where('activo', true)
        .count({ total: '*' })
        .countDistinct({ with_embedding: knex.raw('CASE WHEN embedding IS NOT NULL THEN id END') })
        .first();
      console.log('[backfill] verify:', verify);
    }
  } finally {
    await knex.destroy();
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
