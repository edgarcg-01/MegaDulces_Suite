/**
 * Fase LM.0 (M2) — `commercial.customers.is_casual`.
 *
 * Cliente casual = alta rápida para entrega a domicilio (solo nombre + tel),
 * sin RFC ni cartera formal. Se marca para poder EXCLUIRLO de las MVs de
 * cartera / analytics / Thot (que asumen clientes recurrentes) y así no
 * ensuciar métricas de recompra. Opt-in a cartera formal después.
 *
 * Default false → los clientes existentes quedan como formales. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('commercial.customers', 'is_casual'))) {
    await knex.schema.withSchema('commercial').alterTable('customers', (t) => {
      t.boolean('is_casual').notNullable().defaultTo(false);
    });
    await knex.raw(`
      COMMENT ON COLUMN commercial.customers.is_casual IS
        'Fase LM: cliente casual de domicilio (alta rápida sin cartera). Excluir de MVs de cartera/analytics.'
    `);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  if (await knex.schema.hasColumn('commercial.customers', 'is_casual')) {
    await knex.schema.withSchema('commercial').alterTable('customers', (t) => t.dropColumn('is_casual'));
  }
};
