/**
 * Normalización ALMACÉN — Paso 2, BATCH 2 (aditivo, reversible).
 *
 * Agrega `warehouse_id uuid` (+ índice) a las tablas cuyo `sucursal` (texto) resuelve LIMPIO
 * (100% verificado read-only vs prod 2026-08-18) contra `commercial.warehouses` por
 * `code` OR `wincaja_source_branch` (Kepler 00-05 → code; wincaja 30/32/50 → MD-30/32/50).
 * La columna `sucursal` se conserva como alias legacy. Backfill en script aparte.
 *
 * EXCLUIDAS a propósito (falsos positivos — su `sucursal` NO es almacén, son nºs de banco/área):
 * finance.bank_movements (21%), finance.bank_capture_senders, finance.expense_areas. Y las vacías
 * (finance.bank_capture_inbox/collection_deposits/expense_proofs) entran cuando tengan data + mapeo.
 *
 * @param { import("knex").Knex } knex
 */
const TABLES = [
  ['analytics', 'ap_provider'],
  ['analytics', 'bank_postings'],
  ['analytics', 'erp_collections'],
  ['analytics', 'erp_goods_receipt_lines'],
  ['analytics', 'erp_goods_receipts'],
  ['analytics', 'erp_purchase_adjustments'],
  ['analytics', 'erp_supplier_payments'],
  ['analytics', 'expense_doc_chain'],
  ['analytics', 'expense_document_lines'],
  ['analytics', 'expense_documents'],
  ['analytics', 'expense_entries'],
  ['analytics', 'expense_findings'],
  ['analytics', 'expense_requests'],
  ['analytics', 'gl_poliza_lines'],
  ['analytics', 'gl_polizas'],
  ['analytics', 'kepler_bank_movements'],
  ['analytics', 'ledger_monthly'],
  ['analytics', 'sales_by_channel_monthly'],
  ['finance', 'expense_comprobaciones'],
  ['finance', 'goods_receipt_proofs'],
  ['finance', 'supplier_payment_proofs'],
];

exports.up = async function (knex) {
  for (const [sch, tbl] of TABLES) {
    if (!(await knex.schema.withSchema(sch).hasTable(tbl))) continue;
    if (!(await knex.schema.withSchema(sch).hasColumn(tbl, 'warehouse_id'))) {
      await knex.raw(`ALTER TABLE "${sch}"."${tbl}" ADD COLUMN warehouse_id uuid`);
    }
    await knex.raw(`CREATE INDEX IF NOT EXISTS "ix_${tbl}_warehouse_id" ON "${sch}"."${tbl}" (warehouse_id)`);
  }
};

exports.down = async function (knex) {
  for (const [sch, tbl] of TABLES) {
    await knex.raw(`DROP INDEX IF EXISTS "${sch}"."ix_${tbl}_warehouse_id"`);
    await knex.raw(`ALTER TABLE "${sch}"."${tbl}" DROP COLUMN IF EXISTS warehouse_id`);
  }
};
