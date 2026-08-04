/**
 * Motor de búsqueda compartido — extensiones + wrapper IMMUTABLE de unaccent.
 *
 * Habilita el helper `applySmartSearch` (libs/platform-core) que reemplaza el
 * `ILIKE '%q%'` ingenuo de todos los buscadores por búsqueda:
 *   · insensible a ACENTOS      → `unaccent` (Puruándiro == puruandiro)
 *   · tolerante a TYPOS         → `pg_trgm` / word_similarity (erejon ~ herrejon)
 *   · multi-token, orden libre  → tokeniza el query, AND por token (lógica en el helper)
 *
 * `public.f_unaccent(text)` es un wrapper IMMUTABLE: la forma 1-arg `unaccent(text)`
 * es STABLE (depende del search_path para resolver el diccionario) y NO se puede indexar;
 * la forma 2-arg con el diccionario explícito SÍ es inmutable → habilita índices GIN por
 * expresión a futuro en tablas grandes (movements, products…). Receta canónica PG wiki.
 *
 * Aditiva, boot-safe, idempotente. NO dropea extensiones en down (otras cosas podrían usarlas).
 * Prod ya trae pg_trgm; unaccent es contrib estándar (instalable donde pg_trgm existe).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // OJO: la DB tiene search_path custom (identity primero, …, public). Una extensión
  // se instala en el PRIMER schema del search_path (identity), NO en public → por eso
  // NO calificamos el diccionario a un schema fijo.
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS unaccent`);
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  // Wrapper IMMUTABLE en public (schema estable, siempre en search_path → el helper lo
  // llama como public.f_unaccent). El cuerpo referencia el diccionario SIN calificar: se
  // resuelve por search_path AL CREAR y queda ligado por OID → inmutable aunque el
  // search_path cambie después (patrón canónico PG wiki, adaptado a search_path no-public).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.f_unaccent(text)
      RETURNS text
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    AS $func$ SELECT unaccent('unaccent'::regdictionary, $1) $func$;
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS public.f_unaccent(text)`);
};
