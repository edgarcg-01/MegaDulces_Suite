/**
 * J12.6 — logistics.fuel_transactions: registros reales de carga de combustible
 * (litros, monto, odómetro, estación) por unidad. Permite rendimiento km/l real
 * entre cargas + costo de combustible para ROI. Patrón logistics.* estándar.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('logistics').hasTable('fuel_transactions');
  if (!exists) {
    await knex.schema.withSchema('logistics').createTable('fuel_transactions', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('vehicle_id').notNullable();
      t.uuid('driver_id');
      t.decimal('liters', 10, 2).notNullable();
      t.decimal('amount', 12, 2).notNullable().defaultTo(0); // costo de la carga
      t.integer('odometer_km'); // km al cargar (para rendimiento entre cargas)
      t.string('station', 200);
      t.timestamp('loaded_at').notNullable().defaultTo(knex.fn.now());
      t.text('notes');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('deleted_at');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_fuel_tx_tenant_id_composite' });
      t.index(['tenant_id', 'vehicle_id', 'loaded_at'], 'idx_logistics_fuel_tx_tenant_vehicle');
    });

    await knex.raw(`ALTER TABLE logistics.fuel_transactions ADD CONSTRAINT fk_logistics_fuel_tx_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.fuel_transactions ADD CONSTRAINT fk_logistics_fuel_tx_vehicle FOREIGN KEY (tenant_id, vehicle_id) REFERENCES logistics.vehicles(tenant_id, id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.fuel_transactions ADD CONSTRAINT fk_logistics_fuel_tx_driver FOREIGN KEY (tenant_id, driver_id) REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL`);
    await knex.raw(`ALTER TABLE logistics.fuel_transactions ADD CONSTRAINT logistics_fuel_tx_liters_positive CHECK (liters > 0)`);
    await knex.raw(`ALTER TABLE logistics.fuel_transactions ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.fuel_transactions FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.fuel_transactions USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.fuel_transactions TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('fuel_transactions');
};
