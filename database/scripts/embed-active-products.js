/**
 * One-shot: embeber `inventory.products_active` (set activo ERP) hacia
 * `active_product_embeddings` (vector DB) por SKU, para el match del ticket
 * del vendedor (source='active'). Idempotente: solo re-embebe nuevos/renombrados.
 *
 * Uso (desde database/):
 *   VECTOR_DATABASE_URL='postgres://...' node scripts/embed-active-products.js
 *
 * Requiere VOYAGE_API_KEY (se inyecta desde .env vía el knexfile).
 */
const mainCfg = require('../knexfile-newdb.js').development; // dispara la inyección de .env
const knexLib = require('knex');

const VECTOR_URL = process.env.VECTOR_DATABASE_URL;
if (!VECTOR_URL) {
  console.error('ERROR: falta VECTOR_DATABASE_URL');
  process.exit(1);
}
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
if (!VOYAGE_KEY) {
  console.error('ERROR: falta VOYAGE_API_KEY');
  process.exit(1);
}
const MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-3';
const CHUNK = 100; // Voyage máx 128 inputs/request
const JUNK_RE =
  /descuento|comision|administrativo|tiempo aire|\bflete\b|servicio|redondeo|bonific|anticipo|\babono\b|no usar|cancelad/i;

const main = knexLib(mainCfg);
const vec = knexLib({
  client: 'pg',
  connection: { connectionString: VECTOR_URL, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 2 },
});

async function voyageEmbed(texts) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, model: MODEL, input_type: 'document' }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const rows = await main('inventory.products_active').select(
    'sku',
    'nombre as product_name',
    'categoria as category',
  );
  const active = rows.filter(
    (r) => r.sku && r.product_name && !JUNK_RE.test(r.product_name),
  );
  console.log(`inventory.products_active: ${rows.length} total, ${active.length} tras filtro.`);

  const existing = new Map(
    (await vec('active_product_embeddings').select('sku', 'source_text')).map((r) => [
      r.sku,
      r.source_text,
    ]),
  );
  const stale = active.filter((p) => existing.get(p.sku) !== p.product_name.trim());
  console.log(`a embeber (nuevos/renombrados): ${stale.length}`);
  if (stale.length === 0) {
    console.log('nada que hacer.');
    await main.destroy();
    await vec.destroy();
    return;
  }

  let processed = 0;
  let failed = 0;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const chunk = stale.slice(i, i + CHUNK);
    const texts = chunk.map((p) => p.product_name.trim());
    let vectors;
    try {
      vectors = await voyageEmbed(texts);
    } catch (e) {
      console.warn(`  chunk ${i}-${i + chunk.length} Voyage falló: ${e.message}`);
      failed += chunk.length;
      continue;
    }
    await vec.transaction(async (trx) => {
      for (let j = 0; j < chunk.length; j++) {
        const p = chunk[j];
        await trx.raw(
          `INSERT INTO active_product_embeddings (sku, product_name, category, source_text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?::vector, now())
           ON CONFLICT (sku) DO UPDATE SET
             product_name=EXCLUDED.product_name, category=EXCLUDED.category,
             source_text=EXCLUDED.source_text, embedding=EXCLUDED.embedding, updated_at=now()`,
          [p.sku, p.product_name.trim(), p.category, p.product_name.trim(), `[${vectors[j].join(',')}]`],
        );
      }
    });
    processed += chunk.length;
    console.log(`  ${processed}/${stale.length}…`);
    await sleep(250); // suave con el rate limit de Voyage
  }

  const total = await vec('active_product_embeddings').count('* as n').first();
  console.log(`\nListo. processed=${processed} failed=${failed}. active_product_embeddings=${total.n}.`);
  await main.destroy();
  await vec.destroy();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
