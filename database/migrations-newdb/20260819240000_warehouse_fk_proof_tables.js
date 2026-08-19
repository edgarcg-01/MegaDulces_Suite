/**
 * Cierra las 2 tablas copia que quedaban sin relación: los comprobantes (proofs) de finance.*
 * cargan `warehouse_id` uuid pero no tenían FK a la dim canónica.
 *
 * Verificado (2026-08-19, prod): goods_receipt_proofs 55 filas (49 con warehouse), supplier_payment_proofs
 * 1202 filas (1202 con warehouse) → **0 huérfanos en ambas** → FK segura y validada.
 * Mismo patrón NOT VALID + VALIDATE (instantáneo + escaneo con lock débil, no bloquea captura).
 * Idempotente (skip si ya existe). Sin índice hijo: warehouses es soft-delete, nunca se borra.
 *
 * @param { import("knex").Knex } knex
 */
const TABLES = ['goods_receipt_proofs', 'supplier_payment_proofs'];
const fkName = (t) => `fk_${t}_warehouse`;

exports.up = async function (knex) {
  for (const t of TABLES) {
    const name = fkName(t);
    const exists = await knex.raw(
      `SELECT 1 FROM pg_constraint WHERE conname=? AND conrelid=to_regclass(?)`, [name, `finance.${t}`]);
    if (exists.rows.length) continue;
    await knex.raw(
      `ALTER TABLE finance.${t} ADD CONSTRAINT ${name} FOREIGN KEY (warehouse_id) REFERENCES commercial.warehouses(id) NOT VALID`);
    await knex.raw(`ALTER TABLE finance.${t} VALIDATE CONSTRAINT ${name}`);
  }
};

exports.down = async function (knex) {
  for (const t of TABLES) {
    await knex.raw(`ALTER TABLE finance.${t} DROP CONSTRAINT IF EXISTS ${fkName(t)}`);
  }
};
