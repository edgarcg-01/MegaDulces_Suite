/**
 * GX.2 — Enriquece `analytics.expense_entries` para el reporte de egresos v2:
 *   - cuenta_mayor        : cuenta padre (split_part(cuenta,'-',1)) → jerarquía/menú
 *   - cuenta_mayor_nombre : nombre del mayor desde kdco (lo puebla el importer)
 *   - area                : depto/área normalizado desde el documento (kdm1.c48)
 *
 * Aditiva, idempotente (hasColumn), solo schema analytics.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('expense_entries'))) return;
  const add = async (col, ddl) => {
    if (!(await knex.schema.withSchema('analytics').hasColumn('expense_entries', col))) {
      await knex.raw(`ALTER TABLE analytics.expense_entries ADD COLUMN ${ddl}`);
    }
  };
  await add('cuenta_mayor', 'cuenta_mayor text');
  await add('cuenta_mayor_nombre', 'cuenta_mayor_nombre text');
  await add('area', 'area text');
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_mayor ON analytics.expense_entries (tenant_id, cuenta_mayor)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_area ON analytics.expense_entries (tenant_id, area)`);
};

exports.down = async function (knex) {
  for (const c of ['cuenta_mayor', 'cuenta_mayor_nombre', 'area']) {
    if (await knex.schema.withSchema('analytics').hasColumn('expense_entries', c)) {
      await knex.raw(`ALTER TABLE analytics.expense_entries DROP COLUMN ${c}`);
    }
  }
};
