/**
 * Índice COVERING para las agregaciones 30d del Command Center sobre `analytics.mv_sales_blended`.
 *
 * Los KPIs `network*` agrupan por canal y suman revenue/cost/units en una ventana de 30d. Con sólo el
 * índice (tenant_id, sale_date), el cold-start leía ~200MB de heap (25729 páginas) → 7.7s la primera
 * pasada (506ms warm). Con las columnas del SELECT en INCLUDE, la agregación es INDEX-ONLY (no toca el
 * heap) → rápida aun en frío. `channel` va en INCLUDE para el GROUP BY / el filtro NON_SALE.
 *
 * Idempotente (IF NOT EXISTS). No CONCURRENTLY: el matview aún no lo lee la app en vivo (el swap de los
 * network* va en el mismo deploy), así que el lock breve de CREATE INDEX no afecta.
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_mv_sales_blended_cover
    ON analytics.mv_sales_blended (tenant_id, sale_date) INCLUDE (channel, revenue, cost, units)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ix_mv_sales_blended_cover`);
};
