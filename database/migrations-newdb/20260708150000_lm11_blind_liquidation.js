/**
 * Fase LM.11.1 — Arqueo CIEGO del repartidor + reconciliación del encargado.
 *
 * El repartidor cuenta su efectivo al final del día SIN ver lo esperado
 * (`is_blind`); el sistema calcula la diferencia y la revela al enviar. El
 * encargado reconcilia después (`reconciled_by`/`reconciled_at`), pasando el
 * corte a status 'reconciled'.
 *
 * Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const add = async (col, cb) => {
    if (!(await knex.schema.hasColumn('commercial.rider_liquidations', col))) {
      await knex.schema.withSchema('commercial').alterTable('rider_liquidations', cb);
    }
  };
  await add('is_blind', (t) => t.boolean('is_blind').notNullable().defaultTo(false));
  await add('reconciled_by', (t) => t.uuid('reconciled_by'));
  await add('reconciled_at', (t) => t.timestamp('reconciled_at'));
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const drop = async (col) => {
    if (await knex.schema.hasColumn('commercial.rider_liquidations', col)) {
      await knex.schema.withSchema('commercial').alterTable('rider_liquidations', (t) => t.dropColumn(col));
    }
  };
  await drop('is_blind');
  await drop('reconciled_by');
  await drop('reconciled_at');
};
