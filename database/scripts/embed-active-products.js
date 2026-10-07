/**
 * One-shot: embeber `inventory.products_active` (set activo ERP) hacia
 * `active_product_embeddings` (vector DB) por SKU, para el match del ticket
 * del vendedor (source='active'). Idempotente: solo re-embebe nuevos/renombrados.
 *
 * Calidad del corpus (clave para que el match sea bueno):
 *   - Para skus que existen en `catalog.products` (catálogo comercial curado,
 *     1199), usa el NOMBRE LIMPIO del catálogo (ej. "CANELS 4S") en vez del
 *     nombre ERP ruidoso ("2 CJ CANELS 4S BLS O EXH = GRATIS..."). Así el
 *     ticket matchea el sku correcto y, si está en planograma, entra a la visita.
 *   - Para skus solo en inventory: limpia el nombre ERP y excluye promos/bundles.
 *
 * Uso (desde database/):
 *   VECTOR_DATABASE_URL='postgres://...' node scripts/embed-active-products.js
 */
const mainCfg = require('../knexfile-newdb.js').development; // dispara la inyección de .env
const knexLib = require('knex');

const VECTOR_URL = process.env.VECTOR_DATABASE_URL;
if (!VECTOR_URL) { console.error('ERROR: falta VECTOR_DATABASE_URL'); process.exit(1); }
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
if (!VOYAGE_KEY) { console.error('ERROR: falta VOYAGE_API_KEY'); process.exit(1); }
const MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-3';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const CHUNK = 100;
const JUNK_RE =
  /descuento|comision|administrativo|tiempo aire|\bflete\b|servicio|redondeo|bonific|anticipo|\babono\b|no usar|cancelad/i;
// Promos/bundles (solo se excluyen si el sku NO está en el catálogo curado).
const PROMO_RE = /=\s*gratis|\bgratis\b|\bexh\b|^\s*\d+\s*(cj|cjs|reja|exh|caja|bls|pz|pza|disp)\b/i;

function cleanName(s) {
  return String(s || '')
    .replace(/^\s*ind\s+/i, '') // prefijo distribuidor
    .replace(/\s*\/\s*\d+\s*$/, '') // sufijo "/20"
    .replace(/\s+/g, ' ')
    .trim();
}

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
  // Preferir el nombre limpio del catálogo cuando el sku existe ahí.
  const rows = await main.raw(
    `SELECT ia.sku, ia.nombre AS erp_name, ia.categoria AS category, cp.nombre AS cat_name
     FROM inventory.products_active ia
     LEFT JOIN catalog.products cp ON cp.sku = ia.sku AND cp.tenant_id = ? AND cp.deleted_at IS NULL`,
    [TENANT],
  );
  const active = [];
  for (const r of rows.rows) {
    if (!r.sku) continue;
    const inCatalog = !!r.cat_name;
    const name = inCatalog ? cleanName(r.cat_name) : cleanName(r.erp_name);
    if (!name || JUNK_RE.test(name)) continue;
    if (!inCatalog && PROMO_RE.test(r.erp_name)) continue; // promo fuera del catálogo = ruido
    active.push({ sku: r.sku, source_text: name, category: r.category });
  }
  console.log(`inventory.products_active: ${rows.rows.length} total → ${active.length} a corpus (nombre catálogo preferido, promos/basura excluidas).`);

  const existing = new Map(
    (await vec('active_product_embeddings').select('sku', 'source_text')).map((r) => [r.sku, r.source_text]),
  );
  // Borrar del store los que ya no califican (cambió la regla de filtro).
  const keep = new Set(active.map((a) => a.sku));
  const toDel = [...existing.keys()].filter((s) => !keep.has(s));
  let deleted = 0;
  for (let i = 0; i < toDel.length; i += 500) {
    deleted += await vec('active_product_embeddings').whereIn('sku', toDel.slice(i, i + 500)).del();
  }
  if (deleted) console.log(`borrados ${deleted} (ya no califican).`);

  const stale = active.filter((p) => existing.get(p.sku) !== p.source_text);
  console.log(`a embeber (nuevos/renombrados): ${stale.length}`);
  if (stale.length === 0) { console.log('nada que embeber.'); await main.destroy(); await vec.destroy(); return; }

  let processed = 0, failed = 0;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const chunk = stale.slice(i, i + CHUNK);
    let vectors;
    try { vectors = await voyageEmbed(chunk.map((p) => p.source_text)); }
    catch (e) { console.warn(`  chunk ${i} Voyage falló: ${e.message}`); failed += chunk.length; continue; }
    await vec.transaction(async (trx) => {
      for (let j = 0; j < chunk.length; j++) {
        const p = chunk[j];
        await trx.raw(
          `INSERT INTO active_product_embeddings (sku, product_name, category, source_text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?::vector, now())
           ON CONFLICT (sku) DO UPDATE SET
             product_name=EXCLUDED.product_name, category=EXCLUDED.category,
             source_text=EXCLUDED.source_text, embedding=EXCLUDED.embedding, updated_at=now()`,
          [p.sku, p.source_text, p.category, p.source_text, `[${vectors[j].join(',')}]`],
        );
      }
    });
    processed += chunk.length;
    console.log(`  ${processed}/${stale.length}…`);
    await sleep(250);
  }

  const total = await vec('active_product_embeddings').count('* as n').first();
  console.log(`\nListo. processed=${processed} failed=${failed} deleted=${deleted}. active_product_embeddings=${total.n}.`);
  await main.destroy();
  await vec.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
