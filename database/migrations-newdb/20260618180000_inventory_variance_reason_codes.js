/**
 * Fase I.5 (P1) — reason-codes de varianza en el inventario físico.
 *
 * Hasta ahora la resolución de un item guardaba solo `notes` (texto libre), que
 * no se puede agregar para análisis. `reason_code` clasifica la varianza
 * (merma/caducado/dañado/robo/error/…) habilitando KPI de IRA y dashboard de
 * shrinkage por causa. Se propaga al LEDGER (commercial.stock_movements e
 * inventory.warehouse_stock_movements) para que analytics agregue sin re-joinear
 * los items del folio.
 *
 * Taxonomía validada a nivel servicio (VARIANCE_REASON_CODES en
 * inventory-count.service.ts) — sin CHECK en DB para que el negocio pueda
 * extender la lista sin migración. Columna plain varchar nullable.
 *
 * Aditivo e idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1. item del folio: clasificación de la varianza al resolver
  if (!(await knex.schema.withSchema('commercial').hasColumn('inventory_count_items', 'reason_code'))) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => {
      t.string('reason_code', 30);
    });
    await knex.raw(`COMMENT ON COLUMN commercial.inventory_count_items.reason_code IS 'Clasificación de la varianza (merma/caducado/dañado/robo/error_*/devolucion/transferencia/encontrado/otro). Validada a nivel servicio. notes queda para el detalle libre.'`);
  }

  // 2. ledger commercial (UUID): el ajuste por conteo carga su motivo
  if (!(await knex.schema.withSchema('commercial').hasColumn('stock_movements', 'reason_code'))) {
    await knex.schema.withSchema('commercial').alterTable('stock_movements', (t) => {
      t.string('reason_code', 30);
    });
  }

  // 3. ledger inventory (por SKU): idem
  if (!(await knex.schema.withSchema('inventory').hasColumn('warehouse_stock_movements', 'reason_code'))) {
    await knex.schema.withSchema('inventory').alterTable('warehouse_stock_movements', (t) => {
      t.string('reason_code', 30);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('inventory_count_items', 'reason_code')) {
    await knex.schema.withSchema('commercial').alterTable('inventory_count_items', (t) => t.dropColumn('reason_code'));
  }
  if (await knex.schema.withSchema('commercial').hasColumn('stock_movements', 'reason_code')) {
    await knex.schema.withSchema('commercial').alterTable('stock_movements', (t) => t.dropColumn('reason_code'));
  }
  if (await knex.schema.withSchema('inventory').hasColumn('warehouse_stock_movements', 'reason_code')) {
    await knex.schema.withSchema('inventory').alterTable('warehouse_stock_movements', (t) => t.dropColumn('reason_code'));
  }
};
