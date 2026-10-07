/**
 * Fase 2 tiempos muertos — breadcrumbs GPS.
 *
 * Telemetría de posición del vendedor durante la jornada (pings periódicos
 * mientras la app está en foreground con ruta activa). Es la única señal que
 * separa "trasladándose" de "estacionado sin actividad" → refina la detección
 * de tiempo muerto que la Fase 1 estima solo con haversine entre tiendas.
 *
 * SIN RLS a propósito (igual que commercial.push_subscriptions y
 * portal_telemetry_events): la ingesta corre autenticada y setea `tenant_id`
 * explícito; las lecturas (reports) filtran por tenant_id manualmente. Evita la
 * dependencia del trigger auto_populate (que ha tenido incidentes en prod) y de
 * una policy current_tenant_id() para una tabla de telemetría de alto volumen.
 *
 * Tabla real en `public` (donde viven las tablas base; field_ops/* son vistas
 * passthrough). Se referencia SIEMPRE cualificada como public.route_location_pings.
 *
 * Idempotencia de sync: UNIQUE (tenant_id, client_uuid) — el bulk-insert hace
 * ON CONFLICT DO NOTHING, así re-enviar la cola offline no duplica pings.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('public').hasTable('route_location_pings');
  if (!exists) {
    await knex.schema.withSchema('public').createTable('route_location_pings', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      t.uuid('route_id'); // ruta activa al momento del ping (puede faltar)
      // UUID generado en el cliente para dedupe idempotente en el sync offline.
      t.uuid('client_uuid').notNullable();
      // Momento del fix GPS en el dispositivo (NO el de llegada al server).
      t.timestamp('captured_at', { useTz: true }).notNullable();
      t.decimal('lat', 10, 8).notNullable();
      t.decimal('lng', 11, 8).notNullable();
      t.float('accuracy_m'); // precisión reportada por el GPS (metros) — pg: real
      t.float('speed_mps'); // velocidad instantánea si el device la provee — pg: real
      t.string('source', 20).defaultTo('foreground'); // foreground | background
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.unique(['tenant_id', 'client_uuid'], { indexName: 'uq_route_pings_client' });
      t.index(['user_id', 'captured_at'], 'idx_route_pings_user_time');
      t.index(['route_id', 'captured_at'], 'idx_route_pings_route_time');
      t.index(['tenant_id'], 'idx_route_pings_tenant');
    });

    await knex.raw(
      `GRANT SELECT, INSERT, DELETE ON public.route_location_pings TO app_runtime`,
    );
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('public').dropTableIfExists('route_location_pings');
};
