'use strict';
/**
 * `[PGP.122.17]` — **La compra de un activo, en su renglón: qué es, cuántos y dónde va.**
 *
 * DS47 (Francisco, 2026-11-21): el activo fijo entra a «Pedir un gasto» con su propio formulario; DS55: cada unidad es
 * un activo; DS56: el resguardo NO se pide al solicitar (lo asigna Presupuestos y Control de Activos en el alta). Lo que
 * sólo sabe quien pide —qué es el bien, cuántos y el lugar— es dato propio de la Suite: se EXTIENDE la tabla de renglones
 * que ya existe (regla 2: nada de una tabla nueva para lo que cabe en la que hay). Plan: anexo S §20.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-21) ──
 *  · `finance.expense_proof_lines` no tiene columnas de activo; la única ruta que inserta es `SolicitudGastoService.crear`.
 *  · En 12 meses, 205 solicitudes del alcance v1 compraron activo ($4.67 M), y sólo 5 de 233 renglones dicen cuántos
 *    bienes eran: hoy «cuántos» y «qué es» no se guardan en ningún lado.
 *
 * Las tres columnas admiten nulo (sólo los renglones de activo las llenan), así que ningún camino de inserción cambia
 * (regla 14). `asset_quantity` > 0 cuando viene.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const ESQUEMA = 'finance';
const TABLA = 'expense_proof_lines';
const COLUMNAS = [
  ['asset_description', (t) => t.text('asset_description')],
  ['asset_quantity', (t) => t.integer('asset_quantity')],
  ['asset_location', (t) => t.text('asset_location')],
];
const CHECK = 'expense_proof_lines_asset_quantity_ck';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [col, def] of COLUMNAS) {
    if (!(await knex.schema.withSchema(ESQUEMA).hasColumn(TABLA, col))) {
      await knex.schema.withSchema(ESQUEMA).alterTable(TABLA, def);
    }
  }
  const ya = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'finance.expense_proof_lines'::regclass`, [CHECK]);
  if (!ya.rows.length) {
    await knex.raw(`ALTER TABLE finance.expense_proof_lines ADD CONSTRAINT ${CHECK} CHECK (asset_quantity IS NULL OR asset_quantity > 0)`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE finance.expense_proof_lines DROP CONSTRAINT IF EXISTS ${CHECK}`);
  for (const [col] of [...COLUMNAS].reverse()) {
    if (await knex.schema.withSchema(ESQUEMA).hasColumn(TABLA, col)) {
      await knex.schema.withSchema(ESQUEMA).alterTable(TABLA, (t) => t.dropColumn(col));
    }
  }
};
