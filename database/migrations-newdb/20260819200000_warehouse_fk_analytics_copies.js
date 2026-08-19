/**
 * Normalización (mandato "todo con FK o vista") — FK `warehouse_id → commercial.warehouses(id)`
 * en TODAS las tablas copia de `analytics.*` que cargaban la columna suelta.
 *
 * Análisis (2026-08-19): 42 tablas tienen `warehouse_id` uuid; 2 ya tenían FK (expense_documents/
 * entries, mig 20260819180000); 3 son backups `_snapshot_bak` (se omiten). Las 37 restantes:
 * **0 huérfanos verificado** (incluye sales_daily 3.7M, stock_movements 3.5M, product_sales_daily
 * 2.4M) → FK segura. product_id/supplier_id se posponen: su dim canónica no es commercial.* (vive
 * en catalog/inventory) y las tablas históricas pueden tener huérfanos (productos dados de baja).
 *
 * Patrón `ADD CONSTRAINT … NOT VALID` + `VALIDATE CONSTRAINT`: el ADD es instantáneo (no escanea);
 * el VALIDATE escanea con lock débil (SHARE UPDATE EXCLUSIVE) → NO bloquea los INSERT/UPDATE del
 * feed. Idempotente (skip si la FK ya existe). Sin índice en la columna hija: warehouses nunca se
 * borra (soft-delete), así que el FK no necesita índice de respaldo.
 *
 * @param { import("knex").Knex } knex
 */
const TABLES = [
  'ap_provider', 'bank_postings', 'cash_cuts', 'cash_sessions', 'cedis_supply_cadence',
  'erp_collections', 'erp_promotions', 'erp_purchase_adjustments', 'erp_shipments', 'erp_supplier_payments',
  'expense_doc_chain', 'expense_document_lines', 'expense_findings', 'gl_poliza_lines', 'gl_polizas',
  'inventory_health', 'kepler_bank_movements', 'ledger_monthly', 'pos_cashiers', 'pos_ticket_sales',
  'product_demand', 'product_sales_daily', 'product_sales_monthly', 'purchase_in_transit', 'purchase_velocity',
  'replenishment_plan', 'sales_boxes_monthly', 'sales_by_channel_monthly', 'sales_by_route_monthly',
  'sales_by_vendor_monthly', 'sales_daily', 'sales_monthly', 'stock_ledger', 'stock_movements',
  'store_live_tickets', 'transfer_dest_map', 'transfers_monthly',
];
const fkName = (t) => `fk_${t}_warehouse`;

exports.up = async function (knex) {
  for (const t of TABLES) {
    const name = fkName(t);
    const exists = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname=? AND conrelid=to_regclass(?)`, [name, `analytics.${t}`]);
    if (exists.rows.length) continue;
    await knex.raw(
      `ALTER TABLE analytics.${t} ADD CONSTRAINT ${name} FOREIGN KEY (warehouse_id) REFERENCES commercial.warehouses(id) NOT VALID`);
    await knex.raw(`ALTER TABLE analytics.${t} VALIDATE CONSTRAINT ${name}`);
  }
};

exports.down = async function (knex) {
  for (const t of TABLES) {
    await knex.raw(`ALTER TABLE analytics.${t} DROP CONSTRAINT IF EXISTS ${fkName(t)}`);
  }
};
