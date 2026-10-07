/**
 * Vincula cada cliente con UNA ruta logística (logistics.routes) y propaga
 * automáticamente esa ruta a cada pedido nuevo del cliente.
 *
 * Cambios:
 *   1. commercial.customers.route_id — UUID nullable, FK composite (tenant_id, route_id)
 *      → logistics.routes(tenant_id, id) ON DELETE SET NULL.
 *      Permite asignar la ruta de reparto al cliente desde el CRUD de clientes.
 *
 *   2. commercial.orders.route_id — UUID nullable, mismo FK composite.
 *      Se snapshot-ea desde customer al crear el draft (el service lo hace),
 *      así órdenes históricas mantienen su ruta aunque el cliente cambie de ruta
 *      después. Permite filtrar/agrupar pedidos por ruta para armar embarques.
 *
 * Ambas FK son ON DELETE SET NULL: si la ruta se borra, los clientes/órdenes
 * quedan sin ruta pero no se cae nada. La asignación se puede rehacer manual.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─── commercial.customers.route_id ──────────────────────────────────────
  const customersHasRoute = await knex.schema.hasColumn('commercial.customers', 'route_id');
  if (!customersHasRoute) {
    await knex.schema.withSchema('commercial').alterTable('customers', (t) => {
      t.uuid('route_id');
    });
    await knex.raw(`
      ALTER TABLE commercial.customers
        ADD CONSTRAINT fk_commercial_customers_tenant_route
        FOREIGN KEY (tenant_id, route_id)
        REFERENCES logistics.routes(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      CREATE INDEX idx_commercial_customers_tenant_route
        ON commercial.customers (tenant_id, route_id)
        WHERE route_id IS NOT NULL
    `);
    await knex.raw(`
      COMMENT ON COLUMN commercial.customers.route_id IS
        'Ruta logística asignada al cliente. Snapshot a commercial.orders.route_id al crear el pedido.'
    `);
  }

  // ─── commercial.orders.route_id ─────────────────────────────────────────
  const ordersHasRoute = await knex.schema.hasColumn('commercial.orders', 'route_id');
  if (!ordersHasRoute) {
    await knex.schema.withSchema('commercial').alterTable('orders', (t) => {
      t.uuid('route_id');
    });
    await knex.raw(`
      ALTER TABLE commercial.orders
        ADD CONSTRAINT fk_commercial_orders_tenant_route
        FOREIGN KEY (tenant_id, route_id)
        REFERENCES logistics.routes(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      CREATE INDEX idx_commercial_orders_tenant_route
        ON commercial.orders (tenant_id, route_id)
        WHERE route_id IS NOT NULL
    `);
    await knex.raw(`
      COMMENT ON COLUMN commercial.orders.route_id IS
        'Ruta logística del pedido. Snapshot del customer.route_id al crear el draft. Permite armar embarques agrupados por ruta.'
    `);
  }

  // ─── Backfill: para órdenes existentes sin route_id, copiar del customer ─
  await knex.raw(`
    UPDATE commercial.orders o
       SET route_id = c.route_id
      FROM commercial.customers c
     WHERE c.id = o.customer_id
       AND c.tenant_id = o.tenant_id
       AND c.route_id IS NOT NULL
       AND o.route_id IS NULL
  `);
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('commercial.orders', 'route_id')) {
    await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS fk_commercial_orders_tenant_route`);
    await knex.raw(`DROP INDEX IF EXISTS idx_commercial_orders_tenant_route`);
    await knex.schema.withSchema('commercial').alterTable('orders', (t) => t.dropColumn('route_id'));
  }
  if (await knex.schema.hasColumn('commercial.customers', 'route_id')) {
    await knex.raw(`ALTER TABLE commercial.customers DROP CONSTRAINT IF EXISTS fk_commercial_customers_tenant_route`);
    await knex.raw(`DROP INDEX IF EXISTS idx_commercial_customers_tenant_route`);
    await knex.schema.withSchema('commercial').alterTable('customers', (t) => t.dropColumn('route_id'));
  }
};
