/**
 * Normalización (mandato "todo con FK o vista") — tablas de `/finanzas/comprobaciones`.
 *
 * Estas NO son proyecciones finas de Kepler (expense_documents/entries se derivan de la
 * contabilidad kdc2 con clasificación; las finance.* son HITL capturadas por el usuario) →
 * bucket **tabla**, y les faltaban las **FK** a las dims canónicas. Cargaban `warehouse_id` /
 * `area_id` (uuid, ya poblados y sin huérfanos) como columnas sueltas. Se formalizan:
 *   - analytics.expense_documents.warehouse_id   → commercial.warehouses(id)
 *   - analytics.expense_entries.warehouse_id     → commercial.warehouses(id)
 *   - finance.expense_comprobaciones.warehouse_id→ commercial.warehouses(id)
 *   - finance.expense_comprobaciones.area_id     → finance.expense_areas(id)
 *
 * NO se toca `created_by`/`validated_by` (text = username snapshot denormalizado, patrón del
 * proyecto; `public.users` ni siquiera tiene PK). Idempotente. Verificado: 0 huérfanos.
 *
 * @param { import("knex").Knex } knex
 */

async function addFk(knex, table, name, col, refTable, refCol) {
  const exists = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = to_regclass(?)`, [name, table]);
  if (exists.rows.length) return;
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_${name} ON ${table} (${col})`);
  await knex.raw(
    `ALTER TABLE ${table} ADD CONSTRAINT ${name} FOREIGN KEY (${col}) REFERENCES ${refTable}(${refCol})`);
}

exports.up = async function (knex) {
  await addFk(knex, 'analytics.expense_documents', 'fk_expense_documents_warehouse', 'warehouse_id', 'commercial.warehouses', 'id');
  await addFk(knex, 'analytics.expense_entries', 'fk_expense_entries_warehouse', 'warehouse_id', 'commercial.warehouses', 'id');
  await addFk(knex, 'finance.expense_comprobaciones', 'fk_expense_comprobaciones_warehouse', 'warehouse_id', 'commercial.warehouses', 'id');
  await addFk(knex, 'finance.expense_comprobaciones', 'fk_expense_comprobaciones_area', 'area_id', 'finance.expense_areas', 'id');
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.expense_documents DROP CONSTRAINT IF EXISTS fk_expense_documents_warehouse`);
  await knex.raw(`ALTER TABLE analytics.expense_entries DROP CONSTRAINT IF EXISTS fk_expense_entries_warehouse`);
  await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP CONSTRAINT IF EXISTS fk_expense_comprobaciones_warehouse`);
  await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP CONSTRAINT IF EXISTS fk_expense_comprobaciones_area`);
};
