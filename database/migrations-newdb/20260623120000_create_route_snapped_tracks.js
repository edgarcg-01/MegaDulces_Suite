/**
 * R.1 — Historial de ruta "por calles" (map-matching).
 *
 * Caché de la geometría del recorrido de un vendedor pegada a la red de calles
 * (OSM) vía map-matching (Mapbox). El recorrido de un día pasado es inmutable,
 * así que se calcula UNA vez por (tenant, user, día) y se reusa: minimiza el
 * costo del matching y hace el proveedor intercambiable.
 *
 * SIN RLS (igual que public.route_location_pings, su fuente): se escribe/lee
 * con tenant_id explícito desde el servicio. Tabla real en `public`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('public').hasTable('route_snapped_tracks');
  if (!exists) {
    await knex.schema.withSchema('public').createTable('route_snapped_tracks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      // route_id del día (informativo; el recorrido se cachea por user+día).
      t.uuid('route_id');
      t.date('day').notNullable(); // día del recorrido en TZ MX
      // GeoJSON LineString [[lng,lat],...] del recorrido pegado a calles.
      t.jsonb('geometry').notNullable();
      t.double('distance_m'); // distancia real recorrida (metros, sobre calles)
      t.integer('point_count'); // pings usados como input del matching
      t.float('confidence'); // confianza promedio del matching 0..1
      // Paradas detectadas (dwell): [{lat,lng,arrived,left,minutes,store_id?,store_name?}]
      t.jsonb('stops');
      t.string('provider', 20).defaultTo('mapbox');
      t.timestamp('matched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.index(['tenant_id', 'user_id', 'day'], 'idx_snapped_user_day');
      t.index(['route_id', 'day'], 'idx_snapped_route_day');
    });

    // Unicidad por (tenant, user, día, ruta) — null route_id como sentinela 0.
    await knex.raw(
      `CREATE UNIQUE INDEX uq_snapped_track ON public.route_snapped_tracks
       (tenant_id, user_id, day, COALESCE(route_id, '00000000-0000-0000-0000-000000000000'::uuid))`,
    );

    await knex.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.route_snapped_tracks TO app_runtime`,
    );
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('public').dropTableIfExists('route_snapped_tracks');
};
