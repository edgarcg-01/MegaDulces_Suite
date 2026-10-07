/**
 * Normalización ALMACÉN — Paso 2, BATCH 1 (aditivo, reversible).
 *
 * Agrega `warehouse_id uuid` (+ índice) a las tablas hijas cuyo `warehouse_code` (texto) resuelve
 * LIMPIO contra `commercial.warehouses.code` (verificado read-only vs prod 2026-08-18). La columna
 * de texto se conserva como alias legacy — NADA se rompe. El backfill lo hace un script aparte
 * (per gobernanza: DDL en migración, datos en script): backfill-warehouse-id-batch1.js.
 *
 * NO incluye: columnas `sucursal` (mezcladas Kepler+wincaja), `almacen` (texto libre sucio),
 * espejos crudos kepler_ods.* y wincaja.* (clave natural), ni vistas. Esos van en batches propios.
 *
 * FK/trigger de enforcement = Paso 2b (los importers escriben warehouse_id en cada corrida). Por
 * ahora warehouse_id queda backfilleado + nullable; el texto sigue siendo la clave de trabajo.
 *
 * @param { import("knex").Knex } knex
 */
const TABLES = [
  ['analytics', 'cash_cuts'],
  ['analytics', 'cash_sessions'],
  ['analytics', 'erp_promotions'],
  ['analytics', 'erp_shipments'],
  ['analytics', 'pos_cashiers'],
  ['analytics', 'pos_ticket_sales'],
  ['analytics', 'store_live_tickets'],
  ['analytics', 'stock_ledger'],
  ['identity', 'users'],
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
