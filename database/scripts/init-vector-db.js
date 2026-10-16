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
        in_planogram   boolean NOT NULL DEFAULT false,
        updated_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    // [K.VEC.1] `in_planogram` se agregó al servicio DESPUÉS de este script y acá
    // faltaba. Un `CREATE TABLE IF NOT EXISTS` sobre una tabla vieja no agrega
    // columnas, así que el desfase sobrevive a re-correr el script: medido el
    // 2026-10-16 en prod, el tick del sync murió con `column "in_planogram" does
    // not exist` justo después de crear la tabla con este mismo archivo.
    // El ALTER es la parte que hace al script realmente idempotente.
    await db.raw(`
      ALTER TABLE product_embeddings
        ADD COLUMN IF NOT EXISTS in_planogram boolean NOT NULL DEFAULT false
    `);
    console.log('✓ tabla product_embeddings (+ in_planogram)');

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

    // El KNN del corpus catalog filtra `WHERE in_planogram = true`.
    await db.raw(`
      CREATE INDEX IF NOT EXISTS idx_product_embeddings_planograma
        ON product_embeddings (in_planogram) WHERE in_planogram
    `);
    console.log('✓ índice planograma');

    // ── Corpus ACTIVO ERP (inventory.products_active) — keyed por SKU ──────
    // Tabla SEPARADA del catalog (product_embeddings). La usa SOLO el matcher
    // del ticket del vendedor (source='active'). Sin UUID: el ERP identifica
    // por sku. Sin tenant (ERP global del tenant Mega Dulces).
    await db.raw(`
      CREATE TABLE IF NOT EXISTS active_product_embeddings (
        sku            text PRIMARY KEY,
        product_name   text NOT NULL,
        category       text,
        source_text    text NOT NULL,
        embedding      vector(${EMBED_DIM}) NOT NULL,
        updated_at     timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log('✓ tabla active_product_embeddings');
    await db.raw(`
      CREATE INDEX IF NOT EXISTS idx_active_product_embeddings_hnsw
        ON active_product_embeddings USING hnsw (embedding vector_cosine_ops)
    `);
    console.log('✓ índice HNSW activo (vector_cosine_ops)');

    const cnt = await db('product_embeddings').count('* as n').first();
    const cntA = await db('active_product_embeddings').count('* as n').first();
    console.log(`\nListo. product_embeddings=${cnt.n}, active_product_embeddings=${cntA.n}. dim=${EMBED_DIM}`);
  } catch (e) {
    console.error('\n✗ Error:', e.message);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
