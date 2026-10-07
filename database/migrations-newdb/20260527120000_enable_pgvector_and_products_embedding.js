/**
 * Fase K — AI product match (captures wizard paso 5).
 *
 * Habilita pgvector y agrega columnas de embedding a `products` para que el
 * endpoint `/products/match-ai` pueda hacer KNN semántico contra el catálogo
 * con un operador `<=>` (cosine distance).
 *
 * Decisiones (ver ADR-011 y ADR-012):
 *   - Provider de embeddings: Voyage AI `voyage-3` → 1024 dimensiones.
 *   - Index: HNSW (mejor recall que IVFFLAT para catálogos ≤100k SKUs).
 *   - Index parcial `WHERE activo = true AND embedding IS NOT NULL` para
 *     ignorar soft-deleted y rows sin embedding (aún sin backfill).
 *
 * Idempotente: todo `IF NOT EXISTS`. Re-correr la migración no rompe.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // Extensión a nivel server. En Railway prod corre con la imagen
  // pgvector/pgvector:pgXX; en dev local sobre el container Docker mismo.
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS vector`);

  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS embedding vector(1024),
      ADD COLUMN IF NOT EXISTS embedding_source_text TEXT,
      ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ
  `);

  // HNSW index parcial: ignora soft-deleted y rows sin embedding.
  // Sin el parcial, el index incluye 1278 NULLs y degrada KNN.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS products_embedding_hnsw
      ON products
      USING hnsw (embedding vector_cosine_ops)
      WHERE activo = true AND embedding IS NOT NULL
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS products_embedding_hnsw`);
  await knex.raw(`
    ALTER TABLE products
      DROP COLUMN IF EXISTS embedding_updated_at,
      DROP COLUMN IF EXISTS embedding_source_text,
      DROP COLUMN IF EXISTS embedding
  `);
  // NO dropeamos la extensión: puede haber otros consumidores en el futuro
  // (commercial.products embedded, exhibition similarity, etc.).
};
