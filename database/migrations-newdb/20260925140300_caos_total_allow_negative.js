/**
 * CS.1 fix — `analytics.caos_cash_movements.total` puede ser NEGATIVO.
 *
 * La migración `20260925140000` nació con `CHECK (total >= 0)`. Medido contra CAOS real: tipos de
 * ajuste como "Contenido Modificado" traen total negativo (ej. −$20.00), y "Cambio" trae 0. Un
 * espejo de un sistema externo NO debe imponer signo a un valor que el sistema origen sí firma.
 * Se quita el CHECK. Migración de seguimiento (no edita la aplicada). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.caos_cash_movements DROP CONSTRAINT IF EXISTS caos_mov_total_chk`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.caos_cash_movements DROP CONSTRAINT IF EXISTS caos_mov_total_chk`);
  await knex.raw(`ALTER TABLE analytics.caos_cash_movements ADD CONSTRAINT caos_mov_total_chk CHECK (total >= 0)`);
};
