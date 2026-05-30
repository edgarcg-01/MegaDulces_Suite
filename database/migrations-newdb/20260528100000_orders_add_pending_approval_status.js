/**
 * Agrega el status 'pending_approval' al state machine de commercial.orders.
 *
 * Flujo nuevo:
 *   draft → pending_approval → confirmed → fulfilled
 *   (cancelado puede ocurrir desde cualquier estado excepto fulfilled)
 *
 * Semántica:
 *   draft             — borrador del cliente, editable
 *   pending_approval  — cliente confirmó; stock reservado; espera aprobación del vendedor
 *   confirmed         — vendedor aprobó; en preparación
 *   fulfilled         — entregado; stock consumido
 *   cancelled         — cancelado; reservas liberadas si las había
 *
 * El stock se reserva en draft→pending_approval (cuando el cliente confirma).
 * El consumo de stock sigue en confirmed→fulfilled.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE commercial.orders
      DROP CONSTRAINT commercial_orders_status_valid
  `);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT commercial_orders_status_valid
      CHECK (status IN ('draft', 'pending_approval', 'confirmed', 'fulfilled', 'cancelled'))
  `);

  // Columna para timestamp del paso a pending_approval (cuando el cliente confirma).
  // Idempotente: si ya existe (por re-run), skip.
  const hasCol = await knex.schema.hasColumn('commercial.orders', 'pending_approval_at');
  if (!hasCol) {
    await knex.schema.withSchema('commercial').alterTable('orders', (table) => {
      table.timestamp('pending_approval_at');
    });
  }

  await knex.raw(`
    COMMENT ON COLUMN commercial.orders.pending_approval_at IS
      'Timestamp cuando el cliente confirmó el pedido (status pasó a pending_approval). El vendedor lo verá en su cola de aprobaciones.'
  `);
};

exports.down = async function (knex) {
  // Mover cualquier order en pending_approval a confirmed antes de quitar el status
  // (preserva data; no hay forma de "des-aprobar" semánticamente).
  await knex.raw(`
    UPDATE commercial.orders
       SET status = 'confirmed',
           confirmed_at = COALESCE(confirmed_at, pending_approval_at, NOW())
     WHERE status = 'pending_approval'
  `);

  await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT commercial_orders_status_valid`);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT commercial_orders_status_valid
      CHECK (status IN ('draft', 'confirmed', 'fulfilled', 'cancelled'))
  `);

  if (await knex.schema.hasColumn('commercial.orders', 'pending_approval_at')) {
    await knex.schema.withSchema('commercial').alterTable('orders', (table) => {
      table.dropColumn('pending_approval_at');
    });
  }
};
