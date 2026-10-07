/**
 * Migración J.9.9 — vehicle_usage_logs + vehicle_maintenance.
 *
 * Tablas:
 *   1. logistics.vehicle_usage_logs — historial de check-in/check-out por
 *      conductor + vehículo. Tracking de km al inicio/fin + combustible +
 *      observaciones. Origen: repo logistica fleet/usage/check-in,check-out.
 *   2. logistics.vehicle_maintenance — log de mantenimientos preventivos +
 *      correctivos por vehículo. Origen: repo logistica fleet/maintenance.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // logistics.vehicle_usage_logs — check-in/check-out de uso
  // ─────────────────────────────────────────────────────────────────────────
  const hasUsage = await knex.schema.withSchema('logistics').hasTable('vehicle_usage_logs');
  if (!hasUsage) {
    await knex.schema.withSchema('logistics').createTable('vehicle_usage_logs', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('vehicle_id').notNullable();
      table.uuid('driver_id'); // opcional: chofer asignado
      table.uuid('shipment_id'); // opcional: si vincula a shipment
      table.timestamp('check_in_at').notNullable().defaultTo(knex.fn.now());
      table.integer('check_in_km').notNullable(); // km del odómetro al salir
      table.timestamp('check_out_at');
      table.integer('check_out_km');
      table.decimal('fuel_loaded_liters', 10, 2); // combustible cargado al regreso
      table.text('check_in_notes');
      table.text('check_out_notes');
      table.string('status', 20).notNullable().defaultTo('en_uso'); // en_uso | cerrado
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('created_by');
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('updated_by');

      table.primary('id');
      table.unique(['tenant_id', 'id'], { indexName: 'logistics_vehicle_usage_logs_tenant_id_composite' });

      table.index('tenant_id', 'idx_logistics_vehicle_usage_logs_tenant');
      table.index(['tenant_id', 'vehicle_id'], 'idx_logistics_vehicle_usage_logs_tenant_vehicle');
      table.index(['tenant_id', 'driver_id'], 'idx_logistics_vehicle_usage_logs_tenant_driver');
      table.index(['tenant_id', 'status'], 'idx_logistics_vehicle_usage_logs_tenant_status');
    });

    await knex.raw(`
      ALTER TABLE logistics.vehicle_usage_logs
        ADD CONSTRAINT fk_logistics_vehicle_usage_logs_tenant
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE logistics.vehicle_usage_logs
        ADD CONSTRAINT fk_logistics_vehicle_usage_logs_vehicle
        FOREIGN KEY (tenant_id, vehicle_id)
        REFERENCES logistics.vehicles(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE logistics.vehicle_usage_logs
        ADD CONSTRAINT fk_logistics_vehicle_usage_logs_driver
        FOREIGN KEY (tenant_id, driver_id)
        REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE logistics.vehicle_usage_logs
        ADD CONSTRAINT fk_logistics_vehicle_usage_logs_shipment
        FOREIGN KEY (tenant_id, shipment_id)
        REFERENCES logistics.shipments(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE logistics.vehicle_usage_logs
        ADD CONSTRAINT logistics_vehicle_usage_logs_status_check
        CHECK (status IN ('en_uso', 'cerrado'))
    `);
    await knex.raw(`
      ALTER TABLE logistics.vehicle_usage_logs
        ADD CONSTRAINT logistics_vehicle_usage_logs_km_check
        CHECK (check_out_km IS NULL OR check_out_km >= check_in_km)
    `);

    await knex.raw('ALTER TABLE logistics.vehicle_usage_logs ENABLE ROW LEVEL SECURITY');
    await knex.raw('ALTER TABLE logistics.vehicle_usage_logs FORCE ROW LEVEL SECURITY');
    await knex.raw(`
      CREATE POLICY tenant_isolation ON logistics.vehicle_usage_logs
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.vehicle_usage_logs TO app_runtime');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.vehicle_maintenance — log de mantenimientos
  // ─────────────────────────────────────────────────────────────────────────
  const hasMaint = await knex.schema.withSchema('logistics').hasTable('vehicle_maintenance');
  if (!hasMaint) {
    await knex.schema.withSchema('logistics').createTable('vehicle_maintenance', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('vehicle_id').notNullable();
      table.string('type', 30).notNullable(); // preventivo | correctivo | inspeccion
      table.date('service_date').notNullable();
      table.integer('km_at_service'); // km del odómetro al momento del servicio
      table.string('vendor', 200); // taller / proveedor
      table.string('description', 500).notNullable();
      table.decimal('cost', 14, 2).notNullable().defaultTo(0);
      table.date('next_service_date'); // próximo servicio recomendado
      table.integer('next_service_km'); // próximo servicio recomendado por km
      table.text('notes');
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('created_by');
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('updated_by');
      table.timestamp('deleted_at');

      table.primary('id');
      table.unique(['tenant_id', 'id'], { indexName: 'logistics_vehicle_maintenance_tenant_id_composite' });

      table.index('tenant_id', 'idx_logistics_vehicle_maintenance_tenant');
      table.index(['tenant_id', 'vehicle_id'], 'idx_logistics_vehicle_maintenance_tenant_vehicle');
      table.index(['tenant_id', 'service_date'], 'idx_logistics_vehicle_maintenance_tenant_date');
    });

    await knex.raw(`
      ALTER TABLE logistics.vehicle_maintenance
        ADD CONSTRAINT fk_logistics_vehicle_maintenance_tenant
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE logistics.vehicle_maintenance
        ADD CONSTRAINT fk_logistics_vehicle_maintenance_vehicle
        FOREIGN KEY (tenant_id, vehicle_id)
        REFERENCES logistics.vehicles(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE logistics.vehicle_maintenance
        ADD CONSTRAINT logistics_vehicle_maintenance_type_check
        CHECK (type IN ('preventivo', 'correctivo', 'inspeccion'))
    `);

    await knex.raw('ALTER TABLE logistics.vehicle_maintenance ENABLE ROW LEVEL SECURITY');
    await knex.raw('ALTER TABLE logistics.vehicle_maintenance FORCE ROW LEVEL SECURITY');
    await knex.raw(`
      CREATE POLICY tenant_isolation ON logistics.vehicle_maintenance
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.vehicle_maintenance TO app_runtime');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('vehicle_maintenance');
  await knex.schema.withSchema('logistics').dropTableIfExists('vehicle_usage_logs');
};
