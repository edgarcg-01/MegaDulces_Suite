/**
 * [GPS.B] Geocercas indexadas para tracking de campo.
 *
 * PostGIS NO está disponible en esta instancia (ni instalada ni en
 * pg_available_extensions). `cube` + `earthdistance` SÍ lo están y cubren el
 * caso de uso real: distancia esférica + búsqueda por radio indexada con GiST.
 * Es la alternativa liviana que se decidió en el plan de tracking GPS.
 *
 *   earth_distance(ll_to_earth(a_lat,a_lng), ll_to_earth(b_lat,b_lng))  → metros
 *   earth_box(ll_to_earth(lat,lng), r) @> ll_to_earth(p_lat,p_lng)      → radio (usa índice)
 *
 * DEFENSIVO A PROPÓSITO: si las extensiones no están disponibles (Railway sin
 * los contrib, o rol sin superuser para CREATE EXTENSION), la migración
 * NO crea nada y NO tira error — solo loguea. Así no crashea el boot
 * (patrón aprendido: migraciones que fallan = crash loop en Railway). Los
 * índices se crean únicamente si la extensión quedó instalada.
 *
 * Índices funcionales: la EXPRESIÓN del índice debe coincidir EXACTA con la del
 * WHERE para que el planner lo use — de ahí el cast a float8 y el qualify
 * public.ll_to_earth en todas las queries de geocerca.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const avail = await knex.raw(
    `SELECT name FROM pg_available_extensions WHERE name IN ('cube','earthdistance')`,
  );
  const names = new Set(avail.rows.map((r) => r.name));
  if (!names.has('cube') || !names.has('earthdistance')) {
    console.warn(
      '[GPS.B] cube/earthdistance no disponibles en esta instancia — geocercas quedan sin índice (fallback a haversine en JS). Skipping.',
    );
    return;
  }

  try {
    // earthdistance depende de cube — crear cube primero. SCHEMA public
    // explícito: sin esto se instalarían en el primer schema del search_path
    // (identity) y public.ll_to_earth no existiría.
    await knex.raw('CREATE EXTENSION IF NOT EXISTS cube SCHEMA public');
    await knex.raw('CREATE EXTENSION IF NOT EXISTS earthdistance SCHEMA public');
  } catch (e) {
    console.warn(
      `[GPS.B] CREATE EXTENSION falló (¿rol sin superuser?): ${e.message}. Skipping índices.`,
    );
    return;
  }

  // Índice GiST sobre los breadcrumbs GPS: acelera "pings dentro de radio X".
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_route_pings_earth
       ON public.route_location_pings
       USING gist (public.ll_to_earth(lat::float8, lng::float8))`,
  );

  // Índice GiST sobre clientes con coordenadas: acelera "clientes cerca del
  // vendedor" (detección de llegada / geocerca de tienda a escala).
  const hasCustomers = await knex.schema
    .withSchema('commercial')
    .hasTable('customers');
  if (hasCustomers) {
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_customers_earth
         ON commercial.customers
         USING gist (public.ll_to_earth(latitude::float8, longitude::float8))
         WHERE latitude IS NOT NULL AND longitude IS NOT NULL`,
    );
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS public.idx_route_pings_earth');
  await knex.raw('DROP INDEX IF EXISTS commercial.idx_customers_earth');
  // No se dropean las extensiones: otras features podrían empezar a usarlas.
};
