'use strict';
/**
 * E.12.1 (forward) — CHECK `erp_customer_needs_branch`, en su propia migración porque CRUZA
 * dos columnas de migraciones distintas.
 *
 * Cotizarle a un cliente de Kepler (`erp_customer_code`, agregado por `20260921200000`) sin decir
 * desde qué sucursal (`source_branch`, agregado por `20260921205000`) es irreproducible: las
 * condiciones de mayoreo difieren por sucursal, así que el precio no se podría explicar después.
 *
 * ⚠️ **Vive acá, y no en 200000, por ORDEN**: 200000 tiene timestamp MENOR que 205000, así que si
 * el CHECK va en 200000 corre antes de que exista `source_branch` → `column "source_branch" does
 * not exist`. Ya falló así una vez en prod. La regla: un CHECK que cruza columnas de dos
 * migraciones va en una TERCERA, con timestamp posterior a ambas. Idempotente (guarda por conname).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'commercial_quotes_erp_customer_needs_branch'`);
  if (!rows.length) {
    await knex.raw(`
      ALTER TABLE commercial.quotes
        ADD CONSTRAINT commercial_quotes_erp_customer_needs_branch
        CHECK (erp_customer_code IS NULL OR source_branch IS NOT NULL)
    `);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE commercial.quotes DROP CONSTRAINT IF EXISTS commercial_quotes_erp_customer_needs_branch`);
};
