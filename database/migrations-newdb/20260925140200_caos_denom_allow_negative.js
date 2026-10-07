/**
 * CS.1 fix — `analytics.caos_cash_denominations.denom` puede ser NEGATIVO.
 *
 * La migración `20260925140000` nació con `CHECK (denom > 0)`. Medido contra CAOS real: los
 * movimientos tipo **"Cambio"** traen denominaciones negativas — los billetes que SALEN del cambio
 * (ej. `denom = -50, quantity = 10`) frente a los que entran. Un Cambio es neutro en valor
 * (`sum(denom*quantity) ≈ 0`), con billetes en las dos direcciones, y el SIGNO de `denom` es el
 * que lleva esa dirección. Con `denom > 0` el feed reventaba en esos movimientos.
 *
 * Se corrige a `denom <> 0` (cero sí es basura; negativo es dato). Migración de SEGUIMIENTO en vez
 * de editar la ya aplicada. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.caos_cash_denominations DROP CONSTRAINT IF EXISTS caos_denom_valor_chk`);
  await knex.raw(`ALTER TABLE analytics.caos_cash_denominations ADD CONSTRAINT caos_denom_valor_chk CHECK (denom <> 0)`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.caos_cash_denominations DROP CONSTRAINT IF EXISTS caos_denom_valor_chk`);
  await knex.raw(`ALTER TABLE analytics.caos_cash_denominations ADD CONSTRAINT caos_denom_valor_chk CHECK (denom > 0)`);
};
