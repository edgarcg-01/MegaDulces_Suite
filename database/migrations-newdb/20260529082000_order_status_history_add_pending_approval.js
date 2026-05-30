/**
 * Sincroniza los CHECK de `commercial.order_status_history` con el nuevo
 * status `pending_approval` agregado a `commercial.orders` en
 * 20260528100000. Sin esto, recordHistory() rompe en draft→pending_approval
 * con "violates check constraint commercial_order_status_history_to_status_valid".
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE commercial.order_status_history
      DROP CONSTRAINT commercial_order_status_history_to_status_valid
  `);
  await knex.raw(`
    ALTER TABLE commercial.order_status_history
      ADD CONSTRAINT commercial_order_status_history_to_status_valid
      CHECK (to_status IN ('draft', 'pending_approval', 'confirmed', 'fulfilled', 'cancelled'))
  `);

  await knex.raw(`
    ALTER TABLE commercial.order_status_history
      DROP CONSTRAINT commercial_order_status_history_from_status_valid
  `);
  await knex.raw(`
    ALTER TABLE commercial.order_status_history
      ADD CONSTRAINT commercial_order_status_history_from_status_valid
      CHECK (from_status IS NULL OR from_status IN ('draft', 'pending_approval', 'confirmed', 'fulfilled', 'cancelled'))
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    UPDATE commercial.order_status_history
       SET to_status = 'confirmed'
     WHERE to_status = 'pending_approval'
  `);
  await knex.raw(`
    UPDATE commercial.order_status_history
       SET from_status = 'confirmed'
     WHERE from_status = 'pending_approval'
  `);

  await knex.raw(`ALTER TABLE commercial.order_status_history DROP CONSTRAINT commercial_order_status_history_to_status_valid`);
  await knex.raw(`
    ALTER TABLE commercial.order_status_history
      ADD CONSTRAINT commercial_order_status_history_to_status_valid
      CHECK (to_status IN ('draft', 'confirmed', 'fulfilled', 'cancelled'))
  `);
  await knex.raw(`ALTER TABLE commercial.order_status_history DROP CONSTRAINT commercial_order_status_history_from_status_valid`);
  await knex.raw(`
    ALTER TABLE commercial.order_status_history
      ADD CONSTRAINT commercial_order_status_history_from_status_valid
      CHECK (from_status IS NULL OR from_status IN ('draft', 'confirmed', 'fulfilled', 'cancelled'))
  `);
};
