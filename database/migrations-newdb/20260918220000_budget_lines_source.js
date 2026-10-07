/**
 * Fase PR.1 — Materialización plan → ledger: procedencia en `budget.budget_lines` (ADR-074).
 *
 * Con la captura manual RETIRADA, las partidas del ledger de 5 estados dejan de teclearse: se
 * MATERIALIZAN de los planes (`budget.sales_plan_lines` ingreso, `budget.expense_plan_lines` gasto).
 * Para que la materialización sea idempotente y NUNCA pise una partida legada de captura manual,
 * cada partida declara su origen:
 *   · source     'plan'   = materializada de un plan (la materialización la puede re-sincronizar)
 *                'manual' = legado/excepción (la materialización NO la toca jamás)
 *   · source_ref clave natural de la línea de plan que la originó (p.ej. 'gasto:610:01',
 *                'ingreso:mostrador:01') — la llave de idempotencia de la materialización.
 *
 * Índice único PARCIAL sobre (tenant_id, budget_id, source_ref) para las de plan: una partida por
 * cuenta/entidad por ejercicio. Aditivo, idempotente (hasColumn). Legado queda como 'manual'.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  const has = (col) => knex.schema.withSchema('budget').hasColumn('budget_lines', col);

  if (!(await has('source'))) {
    await knex.raw(`ALTER TABLE budget.budget_lines ADD COLUMN source text NOT NULL DEFAULT 'manual'`);
    await knex.raw(`ALTER TABLE budget.budget_lines ADD CONSTRAINT budget_lines_source_valid CHECK (source IN ('plan','manual'))`);
  }
  if (!(await has('source_ref'))) {
    await knex.raw(`ALTER TABLE budget.budget_lines ADD COLUMN source_ref text`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_budget_lines_plan_ref
                    ON budget.budget_lines (tenant_id, budget_id, source_ref)
                    WHERE source_ref IS NOT NULL`);

  await knex.raw(`COMMENT ON COLUMN budget.budget_lines.source IS
    'PR.1 (ADR-074): plan = materializada de un plan (re-sincronizable); manual = legado/excepción (la materialización no la toca).'`);
  await knex.raw(`COMMENT ON COLUMN budget.budget_lines.source_ref IS
    'PR.1: clave natural de la línea de plan que originó la partida (gasto:<cuenta>:<sucursal> / ingreso:<entity_key>); llave de idempotencia de la materialización.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS budget.ux_budget_lines_plan_ref`);
  if (await knex.schema.withSchema('budget').hasColumn('budget_lines', 'source_ref')) {
    await knex.raw(`ALTER TABLE budget.budget_lines DROP COLUMN source_ref`);
  }
  if (await knex.schema.withSchema('budget').hasColumn('budget_lines', 'source')) {
    await knex.raw(`ALTER TABLE budget.budget_lines DROP CONSTRAINT IF EXISTS budget_lines_source_valid`);
    await knex.raw(`ALTER TABLE budget.budget_lines DROP COLUMN source`);
  }
};
