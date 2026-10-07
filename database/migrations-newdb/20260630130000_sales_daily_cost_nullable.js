/**
 * KV.1 fix — `analytics.sales_daily.cost` pasa a NULLABLE (sin default).
 *
 * El costo por unidad vendida NO es derivable de forma confiable desde
 * `catalog.products.cost_base` (unidad inconsistente: a veces por pieza, a veces
 * por caja/paquete). KV.1 entrega revenue/units reales; el costo/margen se
 * computa en KV.4 con fuente confiable (kdpv_prod_util margen%). Mientras tanto
 * cost = NULL → margin (GENERATED revenue-cost) = NULL = "desconocido" honesto,
 * en vez de 0 que implicaría margen 100%.
 *
 * Aditiva, idempotente, solo schema `analytics`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.sales_daily ALTER COLUMN cost DROP DEFAULT`);
  await knex.raw(`ALTER TABLE analytics.sales_daily ALTER COLUMN cost DROP NOT NULL`);
  // Limpia el costo basura ya cargado (se re-poblará en KV.4).
  await knex.raw(`UPDATE analytics.sales_daily SET cost = NULL WHERE cost IS NOT NULL`);
};

exports.down = async function (knex) {
  await knex.raw(`UPDATE analytics.sales_daily SET cost = 0 WHERE cost IS NULL`);
  await knex.raw(`ALTER TABLE analytics.sales_daily ALTER COLUMN cost SET DEFAULT 0`);
  await knex.raw(`ALTER TABLE analytics.sales_daily ALTER COLUMN cost SET NOT NULL`);
};
