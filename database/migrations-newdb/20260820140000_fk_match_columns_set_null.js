/**
 * FIX P2 — FKs faltantes de columnas 'match' (referencia opcional a una dim), todas con la regla
 * semánticamente correcta `ON DELETE SET NULL` (perder el match no debe borrar el hecho; el NULL es
 * significativo). Composite (tenant_id, col) para respetar el aislamiento multi-tenant. 0 huérfanos
 * verificado en las 5. Idempotente (skip si existe). NOT VALID + VALIDATE (instantáneo + escaneo con
 * lock débil, no bloquea escrituras). Reversible.
 * @param { import("knex").Knex } knex
 */
const FKS = [
  { table: 'logistics.vehicle_stops', col: 'matched_customer_id', ref: 'commercial.customers' },
  { table: 'logistics.vehicle_stops', col: 'matched_store_id', ref: 'trade.stores' },
  { table: 'commercial.prospect_stores', col: 'matched_customer_id', ref: 'commercial.customers' },
  { table: 'commercial.prospect_stores', col: 'matched_store_id', ref: 'trade.stores' },
  { table: 'finance.payment_program', col: 'supplier_id', ref: 'catalog.suppliers' },
];
const fkName = (f) => `fk_${f.table.split('.')[1]}_${f.col}`;

exports.up = async function (knex) {
  for (const f of FKS) {
    const name = fkName(f);
    const exists = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname=? AND conrelid=to_regclass(?)`, [name, f.table]);
    if (exists.rows.length) continue;
    await knex.raw(
      `ALTER TABLE ${f.table} ADD CONSTRAINT ${name} FOREIGN KEY (tenant_id, ${f.col})
         REFERENCES ${f.ref} (tenant_id, id) ON DELETE SET NULL NOT VALID`);
    await knex.raw(`ALTER TABLE ${f.table} VALIDATE CONSTRAINT ${name}`);
  }
};

exports.down = async function (knex) {
  for (const f of FKS) {
    await knex.raw(`ALTER TABLE ${f.table} DROP CONSTRAINT IF EXISTS ${fkName(f)}`);
  }
};
