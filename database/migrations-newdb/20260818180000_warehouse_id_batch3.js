/**
 * Normalización ALMACÉN — Paso 2, BATCH 3 (aditivo, reversible) — cierre del set `warehouse_code`.
 *
 * Tablas con `warehouse_code` limpio que quedaron fuera del batch 1 por estar vacías entonces
 * (reltuples -1). warehouse_code resuelve a commercial.warehouses.code. El backfill (batch1, que
 * ahora las incluye) las llena; corre en el barrido nightly. La columna texto queda como alias.
 *
 * FUERA por diseño (verificado read-only 2026-08-18): las `analytics.caja_*` (Fase CG/Access) usan
 * numeración Access propia (0/20/90…, 0-35% resuelve) = OTRA dimensión → crosswalk aparte, no aquí.
 * finance.bank_* / expense_areas = falsos positivos (nºs de banco/área). vendor_identity 67% parcial.
 *
 * @param { import("knex").Knex } knex
 */
const TABLES = [
  ['logistics', 'home_delivery_warehouses'],
  ['reconciliation', 'actions'],
  ['reconciliation', 'blind_counts'],
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
