/**
 * GX fix — PK sintética para `analytics.expense_entries`.
 *
 * La PK natural (tenant_id, sucursal, doc_tipo, doc_folio, linea) NO es única:
 * las pólizas de diario sin documento (folio vacío) y los folios reciclados por
 * año colisionan → el importer perdía filas al deduplicar. Se cambia a `id uuid`
 * sintética; la idempotencia del feed se logra por DELETE-ventana (sucursal+fecha).
 *
 * Aditiva/idempotente. No revierte (down = no-op) para no romper datos.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('expense_entries'))) return;
  if (!(await knex.schema.withSchema('analytics').hasColumn('expense_entries', 'id'))) {
    await knex.raw(`ALTER TABLE analytics.expense_entries ADD COLUMN id uuid DEFAULT gen_random_uuid()`);
    await knex.raw(`UPDATE analytics.expense_entries SET id = gen_random_uuid() WHERE id IS NULL`);
    await knex.raw(`ALTER TABLE analytics.expense_entries ALTER COLUMN id SET NOT NULL`);
  }
  await knex.raw(`ALTER TABLE analytics.expense_entries DROP CONSTRAINT IF EXISTS expense_entries_pkey`);
  await knex.raw(`ALTER TABLE analytics.expense_entries ADD CONSTRAINT expense_entries_pkey PRIMARY KEY (id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_suc_fecha ON analytics.expense_entries (tenant_id, sucursal, fecha)`);
};

exports.down = async function () {
  // no-op: no revertimos la PK (destructivo).
};
