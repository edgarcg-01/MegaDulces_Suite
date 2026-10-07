/**
 * Fase LM.0 (M1) — `commercial.orders` acepta entrega a domicilio local.
 *
 * - delivery_type += 'home_delivery' (antes: 'route' | 'long_trip').
 * - delivery_address JSONB: dirección ad-hoc del domicilio (recipient_name,
 *   phone, street, references, lat, lng) — independiente de customer.shipping_address,
 *   porque el domicilio puede diferir por pedido y el cliente puede ser casual.
 * - delivery_channel: canal de recepción del SOP (§5.1).
 * - received_at: hora de recepción del pedido (§5.2).
 * - promised_eta_min: tiempo estimado de entrega prometido al cliente (§5.3).
 *
 * Idempotente (hasColumn + DROP CONSTRAINT IF EXISTS). No migra data existente:
 * el default de delivery_type sigue siendo 'route'.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const add = async (col, cb) => {
    if (!(await knex.schema.hasColumn('commercial.orders', col))) {
      await knex.schema.withSchema('commercial').alterTable('orders', cb);
    }
  };

  await add('delivery_address', (t) => t.jsonb('delivery_address'));
  await add('delivery_channel', (t) => t.string('delivery_channel', 20));
  await add('received_at', (t) => t.timestamp('received_at'));
  await add('promised_eta_min', (t) => t.smallint('promised_eta_min'));

  // delivery_type += 'home_delivery' (drop + recreate del CHECK, idempotente).
  await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS commercial_orders_delivery_type_check`);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT commercial_orders_delivery_type_check
      CHECK (delivery_type IN ('route', 'long_trip', 'home_delivery'))
  `);

  // delivery_channel acotado (nullable: solo aplica a home_delivery).
  await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS commercial_orders_delivery_channel_check`);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT commercial_orders_delivery_channel_check
      CHECK (delivery_channel IS NULL OR delivery_channel IN ('phone', 'whatsapp', 'social', 'walk_in'))
  `);

  await knex.raw(`
    COMMENT ON COLUMN commercial.orders.delivery_address IS
      'Fase LM: dirección ad-hoc del domicilio {recipient_name, phone, street, references, lat, lng}. Solo home_delivery.'
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS commercial_orders_delivery_channel_check`);
  await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS commercial_orders_delivery_type_check`);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT commercial_orders_delivery_type_check
      CHECK (delivery_type IN ('route', 'long_trip'))
  `);
  for (const col of ['promised_eta_min', 'received_at', 'delivery_channel', 'delivery_address']) {
    if (await knex.schema.hasColumn('commercial.orders', col)) {
      await knex.schema.withSchema('commercial').alterTable('orders', (t) => t.dropColumn(col));
    }
  }
};
