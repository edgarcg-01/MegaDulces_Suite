/**
 * Fase PR.3 — Obligaciones de gasto AUTO-GENERADAS del plan aprobado (ADR-074).
 *
 * Con la captura manual retirada, las obligaciones de gasto recurrente (renta/luz/sueldos/comisiones)
 * se GENERAN del plan de gastos aprobado en estado `propuesta` — todavía SIN autorizar. Un humano las
 * autoriza en lote (HITL, ADR-064: la autorización nunca se infiere) y recién ahí participan del
 * Calendario. Cambios (aditivos, idempotentes):
 *   · status admite 'propuesta' (antes del pending). El Calendario y el flujo EXCLUYEN 'propuesta'
 *     (una obligación no autorizada NO es un egreso previsto ni asignable).
 *   · authorized_by pasa a NULLABLE (una propuesta no tiene autorizador aún; al autorizar se llena).
 *   · source ('plan'|'manual') + source_ref = idempotencia de la generación (una obligación por
 *     cuenta × sucursal × mes del ejercicio); índice único parcial.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  // status admite 'propuesta'
  await knex.raw(`ALTER TABLE budget.expense_obligations DROP CONSTRAINT IF EXISTS expense_obligations_status_check`);
  await knex.raw(`ALTER TABLE budget.expense_obligations DROP CONSTRAINT IF EXISTS expense_obligations_status_valid`);
  await knex.raw(`ALTER TABLE budget.expense_obligations
                    ADD CONSTRAINT expense_obligations_status_valid
                    CHECK (status IN ('propuesta','pending','partial','paid','cancelled'))`);

  // authorized_by nullable (propuesta aún no autorizada)
  await knex.raw(`ALTER TABLE budget.expense_obligations ALTER COLUMN authorized_by DROP NOT NULL`);

  // procedencia + idempotencia de la generación
  if (!(await knex.schema.withSchema('budget').hasColumn('expense_obligations', 'source'))) {
    await knex.raw(`ALTER TABLE budget.expense_obligations ADD COLUMN source text NOT NULL DEFAULT 'manual'`);
    await knex.raw(`ALTER TABLE budget.expense_obligations ADD CONSTRAINT expense_obligations_source_valid CHECK (source IN ('plan','manual'))`);
  }
  if (!(await knex.schema.withSchema('budget').hasColumn('expense_obligations', 'source_ref'))) {
    await knex.raw(`ALTER TABLE budget.expense_obligations ADD COLUMN source_ref text`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_expense_obl_source_ref
                    ON budget.expense_obligations (tenant_id, source_ref)
                    WHERE source_ref IS NOT NULL`);

  await knex.raw(`COMMENT ON COLUMN budget.expense_obligations.status IS
    'PR.3 (ADR-074): propuesta = auto-generada del plan, sin autorizar (excluida del Calendario y del flujo); al autorizar pasa a pending.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS budget.ux_expense_obl_source_ref`);
  if (await knex.schema.withSchema('budget').hasColumn('expense_obligations', 'source_ref')) {
    await knex.raw(`ALTER TABLE budget.expense_obligations DROP COLUMN source_ref`);
  }
  if (await knex.schema.withSchema('budget').hasColumn('expense_obligations', 'source')) {
    await knex.raw(`ALTER TABLE budget.expense_obligations DROP CONSTRAINT IF EXISTS expense_obligations_source_valid`);
    await knex.raw(`ALTER TABLE budget.expense_obligations DROP COLUMN source`);
  }
  // status/authorized_by: no se revierte el relajado (habría propuestas/nulls que violarían el CHECK viejo).
};
