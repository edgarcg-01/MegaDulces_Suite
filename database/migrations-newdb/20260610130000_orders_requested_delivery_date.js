/**
 * V.5.0 Modo Vendedor v2 — "pedido futuro": fecha de entrega agendada.
 *
 * commercial.orders.requested_delivery_date (date, nullable): el día en que el
 * cliente espera la entrega. NULL = entrega inmediata / sin agendar (autoventa o
 * pedido normal). Índice parcial para listar/filtrar los agendados por día.
 *
 * Idempotente. Aplica a local Y prod via el flujo normal de migrate (deploy).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(
    'ALTER TABLE commercial.orders ADD COLUMN IF NOT EXISTS requested_delivery_date date',
  );
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_orders_requested_delivery_date
      ON commercial.orders (tenant_id, requested_delivery_date)
      WHERE requested_delivery_date IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS commercial.idx_orders_requested_delivery_date');
  await knex.raw('ALTER TABLE commercial.orders DROP COLUMN IF EXISTS requested_delivery_date');
};
