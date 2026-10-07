/**
 * CB.6 — `classified_by` en finance.bank_movements.
 *
 * Distingue clasificación por motor de reglas ('rule') de la reclasificación
 * manual del humano ('manual'). Permite que "reclasificar todo" (re-aplicar las
 * reglas tras editarlas) NO pise las decisiones manuales, y que el re-import
 * idempotente respete el override humano.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasColumn('bank_movements', 'classified_by'))) {
    await knex.raw(`
      ALTER TABLE finance.bank_movements
        ADD COLUMN classified_by text NOT NULL DEFAULT 'rule'
        CHECK (classified_by IN ('rule','manual'))`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('finance').hasColumn('bank_movements', 'classified_by')) {
    await knex.raw(`ALTER TABLE finance.bank_movements DROP COLUMN classified_by`);
  }
};
