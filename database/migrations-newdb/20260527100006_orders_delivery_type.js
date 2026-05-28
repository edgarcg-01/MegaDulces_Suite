/**
 * Migración J.6.6 — agrega `delivery_type` a `commercial.orders`.
 *
 * Valores:
 *   - 'route'     — entrega por ruta regular de reparto (default).
 *   - 'long_trip' — viaje largo, foráneo, vehículo dedicado.
 *
 * Por qué: cuando logística arma el shipment necesita saber el tipo de
 * entrega que el pedido pide para asignar vehículo + estimar costos.
 * Antes de esta migración, lo decidía implícitamente el operador de logística.
 *
 * Default 'route' es el caso común y evita migrar data existente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('commercial.orders', 'delivery_type');
  if (!has) {
    await knex.schema.withSchema('commercial').alterTable('orders', (table) => {
      table.string('delivery_type', 20).notNullable().defaultTo('route');
    });
    await knex.raw(`
      ALTER TABLE commercial.orders
        ADD CONSTRAINT commercial_orders_delivery_type_check
        CHECK (delivery_type IN ('route', 'long_trip'))
    `);
    await knex.raw(`
      COMMENT ON COLUMN commercial.orders.delivery_type IS
        'route = entrega por ruta regular; long_trip = viaje largo dedicado. Define cómo logística arma el shipment.'
    `);
  }
};

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE commercial.orders
      DROP CONSTRAINT IF EXISTS commercial_orders_delivery_type_check
  `);
  await knex.schema.withSchema('commercial').alterTable('orders', (table) => {
    table.dropColumn('delivery_type');
  });
};
