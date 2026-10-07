/**
 * `[PREVENTA]` — Sucursal de surtido por RUTA.
 *
 * El vendedor tiene una ruta (`identity.users.route_id` → `trade.catalogs` cat 'rutas'),
 * y cada ruta se surte de una sucursal. Ese vínculo NO existía en ningún lado (las rutas
 * cuelgan de una ZONA vía `parent_id`, pero ni la ruta ni la zona llegaban a sucursal).
 * Esta tabla lo materializa: `route_id` → `warehouse_id` (central).
 *
 * Con esto el toggle "ver sucursal / ver camioneta" resuelve la sucursal del vendedor
 * como: usuario → su ruta → sucursal de la ruta (fallback: default del tenant).
 *
 * PK (tenant_id, route_id) = una sucursal por ruta. RLS forzado + grant app_runtime,
 * igual que el resto de `commercial.*`.
 */

exports.up = async function up(knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('route_warehouses');
  if (!exists) {
    await knex.schema.withSchema('commercial').createTable('route_warehouses', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('route_id').notNullable(); // trade.catalogs.id (catalog 'rutas')
      t.uuid('warehouse_id').notNullable(); // commercial.warehouses.id (central)
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.primary(['tenant_id', 'route_id']);
      t.index(['tenant_id', 'warehouse_id'], 'idx_route_warehouses_wh');
    });
    // FK compuesta a warehouses (misma forma que el resto de commercial.*).
    await knex.raw(`
      ALTER TABLE commercial.route_warehouses
        ADD CONSTRAINT route_warehouses_wh_fk
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses(tenant_id, id)
        ON DELETE CASCADE`);
    // route_id: FK a trade.catalogs es cross-schema y trade.catalogs valida su propio
    // catalog_id='rutas' — se valida en el service (como users.route_id), no por FK.
    await knex.raw('ALTER TABLE commercial.route_warehouses ENABLE ROW LEVEL SECURITY');
    await knex.raw('ALTER TABLE commercial.route_warehouses FORCE ROW LEVEL SECURITY');
    await knex.raw(`
      CREATE POLICY route_warehouses_tenant_isolation ON commercial.route_warehouses
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid)`);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.route_warehouses TO app_runtime');
  }
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('route_warehouses');
};
