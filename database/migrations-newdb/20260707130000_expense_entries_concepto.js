/**
 * GX.5 — Jerarquía contable de 3 niveles + comentario/beneficiario en egresos.
 *
 * En Kepler la cuenta contable tiene 3 niveles y el modelo solo tenía 2:
 *   - Mayor:     split_part(c3,'-',1)   601      = SUELDOS Y SALARIOS
 *   - Subcuenta: c3 completo            601-001  = SUELDOS
 *   - Concepto:  kdc.c20 → kdco(c3,c1)  001      = NÓMINA BANCOS   ← este faltaba
 *
 * Además, campos que faltaban por póliza:
 *   - comentario      : glosa del documento (kdm1.c24, ej. "SUELDO NOMINA 25 FISCAL")
 *   - beneficiario_doc: beneficiario REAL del documento (kdm1.c32). En gastos, el
 *     `beneficiario` actual (kdc.c6) es en realidad el CONCEPTO, no el proveedor;
 *     este campo trae el proveedor/persona sin romper la vista Proveedores existente.
 *
 * Nombres de mayor/subcuenta se resuelven desde el plan de cuentas `kdc126`
 * (kdco es catálogo de conceptos, no de cuentas → daba nombres arbitrarios).
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
  await add('concepto', 'concepto text');            // código c20
  await add('concepto_nombre', 'concepto_nombre text');
  await add('comentario', 'comentario text');        // glosa del documento (c24)
  await add('beneficiario_doc', 'beneficiario_doc text'); // beneficiario real (c32)
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_concepto ON analytics.expense_entries (tenant_id, concepto)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ix_expense_concepto`);
  for (const c of ['concepto', 'concepto_nombre', 'comentario', 'beneficiario_doc']) {
    if (await knex.schema.withSchema('analytics').hasColumn('expense_entries', c)) {
      await knex.raw(`ALTER TABLE analytics.expense_entries DROP COLUMN ${c}`);
    }
  }
};
