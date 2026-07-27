/**
 * LT.0/LT.1 — logistics.vehicle_positions: breadcrumbs GPS de la flota.
 *
 * Histórico de posiciones (una fila por fix reportado por cada tracker). Alta
 * escritura: el poller inserta ~50 filas/minuto. Alimenta el recorrido histórico
 * y las alertas; la ÚLTIMA posición se sirve desde logistics.trackers.last_*.
 *
 * SIN RLS a propósito — mismo criterio que public.route_location_pings: telemetría
 * de alto volumen, la ingesta corre autenticada y setea `tenant_id` explícito, y
 * las lecturas filtran por tenant_id manualmente. Evita la policy current_tenant_id()
 * y el trigger auto_populate por fila. No hay FK (como route_location_pings) para
 * abaratar el insert; `tracker_id`/`vehicle_id` son refs lógicas.
 *
 * Idempotencia: UNIQUE (tenant_id, tracker_id, captured_at) → el insert hace
 * ON CONFLICT DO NOTHING, así re-pollear el mismo fix no duplica.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('logistics').hasTable('vehicle_positions');
  if (!exists) {
    await knex.schema.withSchema('logistics').createTable('vehicle_positions', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('tracker_id').notNullable();
      t.uuid('vehicle_id'); // denormalizado para consultas por vehículo
      // Momento del fix GPS en el dispositivo (dt_tracker), NO el de llegada al server.
      t.timestamp('captured_at', { useTz: true }).notNullable();
      t.decimal('lat', 10, 8).notNullable();
      t.decimal('lng', 11, 8).notNullable();
      t.integer('speed_kmh');
      t.integer('heading');
      t.boolean('ignition');
      t.bigInteger('odometer');
      t.integer('altitude');
      t.string('status', 12); // moving | stopped | offline | unknown
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.unique(['tenant_id', 'tracker_id', 'captured_at'], { indexName: 'uq_logistics_positions_dedupe' });
      t.index(['tenant_id', 'tracker_id', 'captured_at'], 'idx_logistics_positions_tracker_time');
      t.index(['tenant_id', 'vehicle_id', 'captured_at'], 'idx_logistics_positions_vehicle_time');
    });

    await knex.raw(`GRANT SELECT, INSERT, DELETE ON logistics.vehicle_positions TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('vehicle_positions');
};
