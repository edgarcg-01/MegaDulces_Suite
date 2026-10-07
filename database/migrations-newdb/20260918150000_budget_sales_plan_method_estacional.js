/**
 * Fase PVA.2 — Amplía el CHECK de `budget.sales_plan_lines.method` para admitir el relleno híbrido.
 *
 * Antes: ('historico_ajustado','manual'). Ahora: + 'estacional' — la celda propuesta por PART +
 * estacionalidad donde NO hay real del año anterior (relleno híbrido). Aditivo e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE budget.sales_plan_lines DROP CONSTRAINT IF EXISTS budget_sales_plan_method_valid`);
  await knex.raw(`
    ALTER TABLE budget.sales_plan_lines
      ADD CONSTRAINT budget_sales_plan_method_valid
      CHECK (method IN ('historico_ajustado','estacional','manual'))
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE budget.sales_plan_lines DROP CONSTRAINT IF EXISTS budget_sales_plan_method_valid`);
  await knex.raw(`
    ALTER TABLE budget.sales_plan_lines
      ADD CONSTRAINT budget_sales_plan_method_valid
      CHECK (method IN ('historico_ajustado','manual'))
  `);
};
