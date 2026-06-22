/**
 * J12.7 — logistics.route_optimizations: bitácora del ahorro por optimizar ruta.
 * Guarda km sin optimizar (orden de captura) vs optimizado, por embarque, para
 * cuantificar el ahorro acumulado en el dashboard de ROI. Patrón logistics.*.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('logistics').hasTable('route_optimizations');
  if (!exists) {
    await knex.schema.withSchema('logistics').createTable('route_optimizations', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('shipment_id').notNullable();
      t.decimal('naive_km', 12, 2).notNullable().defaultTo(0);
      t.decimal('optimized_km', 12, 2).notNullable().defaultTo(0);
      t.decimal('saved_km', 12, 2).notNullable().defaultTo(0);
      t.integer('stops').notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_route_opt_tenant_id_composite' });
      t.index(['tenant_id', 'created_at'], 'idx_logistics_route_opt_tenant_created');
    });
    await knex.raw(`ALTER TABLE logistics.route_optimizations ADD CONSTRAINT fk_logistics_route_opt_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.route_optimizations ADD CONSTRAINT fk_logistics_route_opt_shipment FOREIGN KEY (tenant_id, shipment_id) REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE logistics.route_optimizations ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.route_optimizations FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.route_optimizations USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.route_optimizations TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('route_optimizations');
};
