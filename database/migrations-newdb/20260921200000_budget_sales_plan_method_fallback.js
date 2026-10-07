/**
 * Fase PU.9 (Bloque B4 — fallback declarado) — Amplía el CHECK de
 * `budget.sales_plan_lines.method` para admitir el relleno de RESPALDO cuando una entidad no tiene
 * historia propia: «nunca dejar hueco + declarar» (Q3 del usuario, ADR-056).
 *
 * Antes: ('historico_ajustado','estacional','manual').
 * Ahora: + 'proxy_canal'       — estimada desde el promedio×estacionalidad del CANAL (entidad nueva,
 *                                 canal con historia — el caso común: ruta/sucursal nueva).
 *        + 'sin_base_declarado' — ni la entidad ni su canal tienen señal: la entidad IGUAL aparece en
 *                                 el plan, declarada en 0 (no silenciosamente ausente).
 *
 * Aditivo e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE budget.sales_plan_lines DROP CONSTRAINT IF EXISTS budget_sales_plan_method_valid`);
  await knex.raw(`
    ALTER TABLE budget.sales_plan_lines
      ADD CONSTRAINT budget_sales_plan_method_valid
      CHECK (method IN ('historico_ajustado','estacional','proxy_canal','sin_base_declarado','manual'))
  `);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE budget.sales_plan_lines DROP CONSTRAINT IF EXISTS budget_sales_plan_method_valid`);
  await knex.raw(`
    ALTER TABLE budget.sales_plan_lines
      ADD CONSTRAINT budget_sales_plan_method_valid
      CHECK (method IN ('historico_ajustado','estacional','manual'))
  `);
};
