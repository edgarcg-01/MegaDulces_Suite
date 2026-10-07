/**
 * Defense-in-depth para el path inventory-source del inventario físico: la
 * existencia por SKU no puede ser negativa ni quedar bajo lo reservado. El lado
 * commercial ya tiene estos invariantes; el inventory no los tenía (latente hoy,
 * pero blinda contra cualquier escritor futuro — importer Kepler, etc.).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('inventory').hasTable('warehouse_stock'))) return;
  await knex.raw(`ALTER TABLE inventory.warehouse_stock DROP CONSTRAINT IF EXISTS inv_wh_stock_qty_nonneg`);
  await knex.raw(`ALTER TABLE inventory.warehouse_stock ADD CONSTRAINT inv_wh_stock_qty_nonneg CHECK (quantity >= 0)`);
  await knex.raw(`ALTER TABLE inventory.warehouse_stock DROP CONSTRAINT IF EXISTS inv_wh_stock_qty_ge_reserved`);
  await knex.raw(`ALTER TABLE inventory.warehouse_stock ADD CONSTRAINT inv_wh_stock_qty_ge_reserved CHECK (quantity >= reserved_quantity)`);
};

exports.down = async function (knex) {
  if (!(await knex.schema.withSchema('inventory').hasTable('warehouse_stock'))) return;
  await knex.raw(`ALTER TABLE inventory.warehouse_stock DROP CONSTRAINT IF EXISTS inv_wh_stock_qty_nonneg`);
  await knex.raw(`ALTER TABLE inventory.warehouse_stock DROP CONSTRAINT IF EXISTS inv_wh_stock_qty_ge_reserved`);
};
