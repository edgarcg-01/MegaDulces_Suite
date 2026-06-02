/**
 * Inicializa la DB dedicada del RAG (vector store) — Fase K v2.
 *
 * Crea la extensión pgvector + la tabla denormalizada `product_embeddings` +
 * el índice HNSW para KNN coseno. Idempotente (IF NOT EXISTS).
 *
 * La tabla es denormalizada a propósito: el matcher hace KNN puro sin join
 * cross-DB. `source_text` permite detectar drift (renombres) en el sync.
 *
 * Uso:
 *   VECTOR_DATABASE_URL='postgres://...' node database/scripts/init-vector-db.js
 */
const path = require('path');
const knex = require(path.join(__dirname, '..', '..', 'node_modules', 'knex'));

const URL = process.env.VECTOR_DATABASE_URL;
if (!URL) {
  console.error('ERROR: falta VECTOR_DATABASE_URL');
  process.exit(1);
}
const EMBED_DIM = Number(process.env.VECTOR_EMBED_DIM) || 1024; // voyage-3 = 1024

const db = knex({
  client: 'pg',
  connection: {
    connectionString: URL,
    ssl: /rlwy|railway|proxy|amazonaws|render|supabase/i.test(URL)
      ? { rejectUnauthorized: false }
      : false,
  },
  pool: { min: 0, max: 2 },
});

(async () => {
  try {
    await db.raw('CREATE EXTENSION IF NOT EXISTS vector');
    console.log('✓ extensión pgvector');

    await db.raw(`
      CREATE TABLE IF NOT EXISTS product_embeddings (
        product_id     uuid PRIMARY KEY,
        tenant_id      uuid,
        brand_id       uuid,
        brand_name     text,
        product_name   text NOT NULL,
        source_text    text NOT NULL,
        embedding      vector(${EMBED_DIM}) NOT NULL,
        updated_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log('✓ tabla product_embeddings');

    // HNSW para KNN coseno — el operador del matcher es `<=>` (cosine distance).
    await db.raw(`
      CREATE INDEX IF NOT EXISTS idx_product_embeddings_hnsw
        ON product_embeddings USING hnsw (embedding vector_cosine_ops)
    `);
    console.log('✓ índice HNSW (vector_cosine_ops)');

    // Index auxiliar para el sweep de borrado de inactivos por tenant.
    await db.raw(`
      CREATE INDEX IF NOT EXISTS idx_product_embeddings_tenant
        ON product_embeddings (tenant_id)
    `);
    console.log('✓ índice tenant');

    const cnt = await db('product_embeddings').count('* as n').first();
    console.log(`\nListo. product_embeddings tiene ${cnt.n} filas. dim=${EMBED_DIM}`);
  } catch (e) {
    console.error('\n✗ Error:', e.message);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
