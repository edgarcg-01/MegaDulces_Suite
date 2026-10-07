/**
 * GX.4 — Departamento (centro de costos) en `analytics.expense_entries`.
 *
 * En Kepler el depto/centro de costos vive a nivel RENGLÓN DE PÓLIZA en
 * `kdc2YYMM.c13` (código jerárquico, ej. '1-01-10-00'); el nombre está en el
 * catálogo `md.kdc3` (c1=código, c2=nombre, ej. 'PADRE HIDALGO PISO',
 * 'LOGISTICA GENERAL'). Se usa fuerte en CEDIS (~67% de renglones de egreso);
 * las sucursales casi no lo capturan. Distinto de `area` (kdm1.c48, texto libre).
 *
 * Lo puebla `import-expenses-polizas.js`. Consumido por el filtro/dimensión
 * "Departamento" del reporte de egresos.
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
  await add('dpto', 'dpto text');
  await add('dpto_nombre', 'dpto_nombre text');
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_dpto ON analytics.expense_entries (tenant_id, dpto)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ix_expense_dpto`);
  for (const c of ['dpto', 'dpto_nombre']) {
    if (await knex.schema.withSchema('analytics').hasColumn('expense_entries', c)) {
      await knex.raw(`ALTER TABLE analytics.expense_entries DROP COLUMN ${c}`);
    }
  }
};
