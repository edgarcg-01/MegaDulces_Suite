/**
 * LTV.0 — reconstrucción de viajes: paradas + resumen diario por vehículo.
 *
 * Segmenta el rastro crudo (logistics.vehicle_positions) en:
 *   - logistics.vehicle_stops: dónde estuvo detenido y cuánto (matcheado a cliente
 *     por cercanía cuando hay coords).
 *   - logistics.vehicle_day_summary: km recorridos, tiempo movimiento/detenido, etc.
 *
 * Keystone de la Fase LTV (cumplimiento de ruta, productividad, costo/ROI). Se
 * reconstruye nightly. Patrón logistics.* estándar (RLS forzado).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasStops = await knex.schema.withSchema('logistics').hasTable('vehicle_stops');
  if (!hasStops) {
    await knex.schema.withSchema('logistics').createTable('vehicle_stops', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('vehicle_id').notNullable();
      t.timestamp('arrived_at', { useTz: true }).notNullable();
      t.timestamp('left_at', { useTz: true }).notNullable();
      t.integer('minutes').notNullable();
      t.decimal('lat', 10, 8).notNullable();
      t.decimal('lng', 11, 8).notNullable();
      t.uuid('matched_customer_id'); // soft ref a commercial.customers (sin FK, cross-schema)
      t.uuid('matched_store_id'); // soft ref a public.stores
      t.integer('match_distance_m');
      t.boolean('is_customer').notNullable().defaultTo(false);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_vehicle_stops_tenant_id_composite' });
      t.unique(['tenant_id', 'vehicle_id', 'arrived_at'], { indexName: 'uq_logistics_vehicle_stops' });
      t.index(['tenant_id', 'vehicle_id', 'arrived_at'], 'idx_logistics_vehicle_stops_vehicle_time');
      t.index(['tenant_id', 'matched_customer_id'], 'idx_logistics_vehicle_stops_customer');
    });
    await knex.raw(`ALTER TABLE logistics.vehicle_stops ADD CONSTRAINT fk_logistics_vehicle_stops_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.vehicle_stops ADD CONSTRAINT fk_logistics_vehicle_stops_vehicle FOREIGN KEY (tenant_id, vehicle_id) REFERENCES logistics.vehicles(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE logistics.vehicle_stops ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.vehicle_stops FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.vehicle_stops USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.vehicle_stops TO app_runtime`);
  }

  const hasSummary = await knex.schema.withSchema('logistics').hasTable('vehicle_day_summary');
  if (!hasSummary) {
    await knex.schema.withSchema('logistics').createTable('vehicle_day_summary', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('vehicle_id').notNullable();
      t.date('day').notNullable();
      t.decimal('km_driven', 10, 2).notNullable().defaultTo(0);
      t.integer('moving_min').notNullable().defaultTo(0);
      t.integer('stopped_min').notNullable().defaultTo(0);
      t.integer('offline_min').notNullable().defaultTo(0);
      t.integer('stops_count').notNullable().defaultTo(0);
      t.integer('customer_stops').notNullable().defaultTo(0);
      t.timestamp('first_move_at', { useTz: true });
      t.timestamp('last_stop_at', { useTz: true });
      t.integer('max_speed_kmh');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_vehicle_day_summary_tenant_id_composite' });
      t.unique(['tenant_id', 'vehicle_id', 'day'], { indexName: 'uq_logistics_vehicle_day_summary' });
      t.index(['tenant_id', 'day'], 'idx_logistics_vehicle_day_summary_day');
    });
    await knex.raw(`ALTER TABLE logistics.vehicle_day_summary ADD CONSTRAINT fk_logistics_vds_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.vehicle_day_summary ADD CONSTRAINT fk_logistics_vds_vehicle FOREIGN KEY (tenant_id, vehicle_id) REFERENCES logistics.vehicles(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE logistics.vehicle_day_summary ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.vehicle_day_summary FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.vehicle_day_summary USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.vehicle_day_summary TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('vehicle_day_summary');
  await knex.schema.withSchema('logistics').dropTableIfExists('vehicle_stops');
};
