/**
 * LT.0 — logistics.trackers: registro de dispositivos GPS de la flota.
 *
 * Un row por dispositivo físico (IMEI) que reporta un proveedor externo de
 * rastreo (hoy MagniTracking / GPS-Server.net). Un vehículo físico puede tener
 * VARIOS trackers (ej: un GPS Ruptela + una dashcam Streamax) → cada IMEI es su
 * propia fila y `vehicle_id` los agrupa contra logistics.vehicles.
 *
 * Guarda la ÚLTIMA posición denormalizada (last_*) para que el mapa en vivo lea
 * ~50 filas sin tocar el histórico de alto volumen (logistics.vehicle_positions).
 *
 * Patrón logistics.* estándar (RLS forzado) — bajo volumen, ~decenas de filas.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('logistics').hasTable('trackers');
  if (!exists) {
    await knex.schema.withSchema('logistics').createTable('trackers', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('provider', 40).notNullable().defaultTo('magnitracking');
      t.string('imei', 48).notNullable(); // id del objeto en el proveedor
      t.text('external_name'); // nombre crudo del proveedor (placa + ruta + notas)
      t.string('sim_number', 30);
      t.string('protocol', 40); // ruptela | streamax | ...
      t.string('object_type', 20); // vehicle | person | app | iot
      t.uuid('vehicle_id'); // FK composite → logistics.vehicles (nullable: se vincula luego)
      t.string('route_code', 20); // R-NN parseado del nombre (nullable)

      // Última posición denormalizada (para el mapa en vivo).
      t.decimal('last_lat', 10, 8);
      t.decimal('last_lng', 11, 8);
      t.integer('last_speed_kmh');
      t.integer('last_heading');
      t.boolean('last_ignition');
      t.bigInteger('last_odometer');
      t.string('last_status', 12); // moving | stopped | offline | unknown
      t.text('last_status_text'); // ststr del proveedor ("Detenido 16 S")
      t.timestamp('last_seen_at', { useTz: true }); // dt_tracker del último fix
      t.timestamp('last_synced_at', { useTz: true }); // cuándo hicimos el poll

      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.timestamp('deleted_at', { useTz: true });
      t.uuid('deleted_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_trackers_tenant_id_composite' });
      t.unique(['tenant_id', 'imei'], { indexName: 'uq_logistics_trackers_tenant_imei' });
      t.index(['tenant_id', 'vehicle_id'], 'idx_logistics_trackers_tenant_vehicle');
      t.index(['tenant_id', 'last_status'], 'idx_logistics_trackers_tenant_status');
    });

    await knex.raw(`ALTER TABLE logistics.trackers ADD CONSTRAINT fk_logistics_trackers_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.trackers ADD CONSTRAINT fk_logistics_trackers_vehicle FOREIGN KEY (tenant_id, vehicle_id) REFERENCES logistics.vehicles(tenant_id, id) ON DELETE SET NULL`);
    await knex.raw(`ALTER TABLE logistics.trackers ADD CONSTRAINT logistics_trackers_status_valid CHECK (last_status IS NULL OR last_status IN ('moving','stopped','offline','unknown'))`);
    await knex.raw(`ALTER TABLE logistics.trackers ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.trackers FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.trackers USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.trackers TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('trackers');
};
