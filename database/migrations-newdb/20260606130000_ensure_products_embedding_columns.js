/**
 * Fix — garantizar las columnas de embedding que el trigger
 * `products_mark_embedding_stale` (mig 20260527150000) referencia en CADA
 * UPDATE/INSERT de `products`.
 *
 * Problema: el trigger setea `NEW.embedding_source_text` y
 * `NEW.embedding_updated_at`. En prod esas columnas faltaban (las migraciones
 * de Fase K se aplicaron como shim solo en el Docker pgvector local, no en el
 * boot de prod), pero el trigger SÍ se creó. plpgsql no valida las referencias
 * a columnas al crear la función, así que el trigger se creó OK y reventaba en
 * runtime con `record "new" has no field "embedding_source_text"` (42703) →
 * TODO UPDATE de producto fallaba ("tira error al guardar" desde el planograma).
 *
 * Estas dos columnas son PLANAS (text + timestamptz): NO requieren la extensión
 * pgvector. La columna `embedding` (tipo vector) NO se toca acá — el trigger no
 * la usa y el hook `embedProduct` degrada elegante si falta.
 *
 * Defensiva: resuelve el schema real de la tabla `products` (relkind='r') para
 * no abortar el boot si el layout difiere. Idempotente (ADD COLUMN IF NOT EXISTS).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const { rows } = await knex.raw(`
    SELECT n.nspname AS schema
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'products' AND c.relkind = 'r'
    ORDER BY (n.nspname = 'catalog') DESC
    LIMIT 1
  `);
  if (!rows.length) {
    console.log('  · tabla products real no encontrada — nada que hacer');
    return;
  }
  const schema = rows[0].schema;
  await knex.raw(`ALTER TABLE "${schema}".products ADD COLUMN IF NOT EXISTS embedding_source_text text`);
  await knex.raw(`ALTER TABLE "${schema}".products ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz`);
  console.log(`  ✓ embedding_source_text + embedding_updated_at garantizadas en ${schema}.products`);
};

/**
 * No-op: las columnas son parte del esquema Fase K y el trigger las necesita.
 * Borrarlas re-introduciría el bug del 42703 mientras el trigger exista.
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // Intencionalmente vacío.
};
