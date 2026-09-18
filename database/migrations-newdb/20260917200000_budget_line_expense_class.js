/**
 * Fase PU.7 — Presupuestos: clasificación de gasto operativo (ADR-066, spec §9).
 *
 * Los gastos operativos se clasifican en dos ejes (spec §9): fijo/variable y
 * recurrente/no recurrente. Se agregan como columnas de la partida (`budget.budget_lines`),
 * nullable — solo aplican a `line_type='gasto'` (el resto de tipos las deja NULL). Aditivo,
 * idempotente. No hay tabla nueva: es un atributo de la partida que ya existe.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('budget').hasColumn('budget_lines', 'expense_class'))) {
    await knex.raw(`ALTER TABLE budget.budget_lines ADD COLUMN expense_class text
                      CHECK (expense_class IS NULL OR expense_class IN ('fijo','variable'))`);
  }
  if (!(await knex.schema.withSchema('budget').hasColumn('budget_lines', 'recurrence'))) {
    await knex.raw(`ALTER TABLE budget.budget_lines ADD COLUMN recurrence text
                      CHECK (recurrence IS NULL OR recurrence IN ('recurrente','no_recurrente'))`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('budget').hasColumn('budget_lines', 'recurrence')) {
    await knex.raw(`ALTER TABLE budget.budget_lines DROP COLUMN recurrence`);
  }
  if (await knex.schema.withSchema('budget').hasColumn('budget_lines', 'expense_class')) {
    await knex.raw(`ALTER TABLE budget.budget_lines DROP COLUMN expense_class`);
  }
};
