/**
 * Fase PU.4 — Presupuestos: escenarios + linaje de copia (ADR-066).
 *
 * Planeación avanzada (spec §4/§5.2): un presupuesto puede ser un ESCENARIO (base/conservador/
 * expansión) y puede nacer de COPIAR un ejercicio anterior — "sin arrastrar autorizaciones" (la copia
 * arranca en borrador, con buckets en cero y vigente = original). Se agrega:
 *   - budget.budgets.scenario      — el escenario (default 'base'; escenario ≠ versión, spec §4).
 *   - budget.budgets.copied_from_id — de qué presupuesto se copió (linaje/trazabilidad).
 *
 * Aditivo e idempotente (hasColumn). No toca datos existentes.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('budget').hasColumn('budgets', 'scenario'))) {
    await knex.raw(`ALTER TABLE budget.budgets ADD COLUMN scenario text NOT NULL DEFAULT 'base'
                      CHECK (scenario IN ('base','conservador','expansion'))`);
  }
  if (!(await knex.schema.withSchema('budget').hasColumn('budgets', 'copied_from_id'))) {
    await knex.raw(`ALTER TABLE budget.budgets ADD COLUMN copied_from_id uuid`);
    await knex.raw(`ALTER TABLE budget.budgets
                      ADD CONSTRAINT fk_budget_copied_from
                      FOREIGN KEY (tenant_id, copied_from_id)
                      REFERENCES budget.budgets (tenant_id, id) ON DELETE SET NULL`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('budget').hasColumn('budgets', 'copied_from_id')) {
    await knex.raw(`ALTER TABLE budget.budgets DROP CONSTRAINT IF EXISTS fk_budget_copied_from`);
    await knex.raw(`ALTER TABLE budget.budgets DROP COLUMN copied_from_id`);
  }
  if (await knex.schema.withSchema('budget').hasColumn('budgets', 'scenario')) {
    await knex.raw(`ALTER TABLE budget.budgets DROP COLUMN scenario`);
  }
};
