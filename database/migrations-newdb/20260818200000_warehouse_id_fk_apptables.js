/**
 * Normalización ALMACÉN — Paso 2, ENFORCEMENT (aditivo, reversible).
 *
 * FK compuesto `(tenant_id, warehouse_id) → commercial.warehouses(tenant_id, id)` SOLO en las
 * tablas escritas POR LA APP (no feeds). Ahí el FK aporta: (a) caza un insert manual con
 * warehouse_id inválido, (b) garantiza tenant-consistencia (el almacén es del mismo tenant).
 * NULL permitido (MATCH SIMPLE → filas sin almacén no se chequean). Los checks de FK bypassean
 * RLS, así que funciona pese al RLS FORCE de commercial.warehouses. Referencia la UNIQUE
 * (tenant_id, id) = commercial_warehouses_tenant_id_composite.
 *
 * NO se ponen FK en las 29 tablas de feed (analytics.*): va contra la convención (analytics
 * sin FK), el resolver ya garantiza validez (solo ids reales o NULL), almacenes soft-delete
 * (sin huérfanos), y en tablas grandes el FK traba + overhead. Enforcement de bajo valor ahí.
 *
 * @param { import("knex").Knex } knex
 */
const TABLES = [
  ['identity', 'users'],
  ['logistics', 'home_delivery_warehouses'],
  ['reconciliation', 'actions'],
  ['reconciliation', 'blind_counts'],
];

exports.up = async function (knex) {
  for (const [sch, tbl] of TABLES) {
    if (!(await knex.schema.withSchema(sch).hasTable(tbl))) continue;
    if (!(await knex.schema.withSchema(sch).hasColumn(tbl, 'warehouse_id'))) continue;
    const name = `fk_${tbl}_warehouse`;
    const exists = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname=? AND conrelid=?::regclass`, [name, `${sch}.${tbl}`]);
    if (!exists.rows.length) {
      await knex.raw(`ALTER TABLE "${sch}"."${tbl}" ADD CONSTRAINT "${name}"
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id)`);
    }
  }
};

exports.down = async function (knex) {
  for (const [sch, tbl] of TABLES) {
    await knex.raw(`ALTER TABLE "${sch}"."${tbl}" DROP CONSTRAINT IF EXISTS "fk_${tbl}_warehouse"`);
  }
};
