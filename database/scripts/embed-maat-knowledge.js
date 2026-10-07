/**
 * MAAT.9 (RAG) — Backfill del índice semántico de la base de conocimiento de Maat.
 *
 * Lee `finance.knowledge` (status='active') de la newdb y embebe title+body con
 * Voyage (voyage-3, input_type='document') hacia `maat_knowledge_embeddings` en
 * la DB vector dedicada (VECTOR_DATABASE_URL). Idempotente: UPSERT por
 * (tenant_id, kind, title) — re-correr re-embebe con el body vigente.
 *
 * Espeja el DDL de MaatKnowledgeVectorService (mismo nombre de tabla, PK e índice
 * HNSW) para que la app y este script escriban al mismo lugar.
 *
 * Uso (desde database/):
 *   DATABASE_URL_NEW='postgres://...proxy...?sslmode=no-verify' \
 *   VECTOR_DATABASE_URL='postgres://...acela...' \
 *   VOYAGE_API_KEY='pa-...' \
 *   node scripts/embed-maat-knowledge.js
 */
const mainCfg = require('../knexfile-newdb.js').development; // dispara la carga de .env
const knexLib = require('knex');

const VECTOR_URL = process.env.VECTOR_DATABASE_URL;
if (!VECTOR_URL) { console.error('ERROR: falta VECTOR_DATABASE_URL'); process.exit(1); }
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
if (!VOYAGE_KEY) { console.error('ERROR: falta VOYAGE_API_KEY'); process.exit(1); }
const MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-3';
const TENANT = process.env.MAAT_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const VEC_DIM = 1024;
const CHUNK = 64;

// Si DATABASE_URL_NEW apunta al proxy público, úsalo (prod); si no, el knexfile.
const mainConn = process.env.DATABASE_URL_NEW
  ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: { rejectUnauthorized: false } }, pool: { min: 0, max: 2 } }
  : mainCfg;

const main = knexLib(mainConn);
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
  await vec.raw('CREATE EXTENSION IF NOT EXISTS vector');
  await vec.raw(`
    CREATE TABLE IF NOT EXISTS maat_knowledge_embeddings (
      tenant_id  text NOT NULL,
      kind       text NOT NULL,
      title      text NOT NULL,
      body       text NOT NULL,
      source     text,
      embedding  vector(${VEC_DIM}),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, kind, title)
    )`);
  await vec.raw(`CREATE INDEX IF NOT EXISTS idx_maat_kb_emb_hnsw ON maat_knowledge_embeddings USING hnsw (embedding vector_cosine_ops)`)
    .catch((e) => console.warn(`(aviso) índice HNSW: ${e.message}`));

  const rows = await main('finance.knowledge')
    .where({ tenant_id: TENANT, status: 'active' })
    .select('kind', 'title', 'body', 'source')
    .orderBy(['kind', 'title']);
  console.log(`finance.knowledge activo: ${rows.length} entradas.`);
  if (!rows.length) { await main.destroy(); await vec.destroy(); return; }

  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const texts = batch.map((r) => `${r.title}\n${r.body}`);
    let embs;
    try {
      embs = await voyageEmbed(texts);
    } catch (e) {
      console.error(`Voyage falló en batch ${i}: ${e.message} — retry en 3s`);
      await sleep(3000);
      embs = await voyageEmbed(texts);
    }
    for (let j = 0; j < batch.length; j++) {
      const r = batch[j];
      const lit = `[${embs[j].join(',')}]`;
      await vec.raw(
        `INSERT INTO maat_knowledge_embeddings (tenant_id, kind, title, body, source, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?::vector, now())
         ON CONFLICT (tenant_id, kind, title) DO UPDATE SET
           body = EXCLUDED.body, source = EXCLUDED.source, embedding = EXCLUDED.embedding, updated_at = now()`,
        [TENANT, r.kind, r.title, r.body, r.source || null, lit],
      );
      done++;
    }
    console.log(`  embebidas ${done}/${rows.length}`);
    await sleep(200);
  }

  const [{ count }] = await vec('maat_knowledge_embeddings').where({ tenant_id: TENANT }).count();
  console.log(`✅ Índice maat_knowledge_embeddings: ${count} filas para el tenant.`);
  await main.destroy();
  await vec.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
