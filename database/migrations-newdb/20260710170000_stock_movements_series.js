/**
 * DM.3 — Contrapartes de traspaso: agrega serie del documento y serie del padre a
 * analytics.stock_movements. El pareo salida↔recepción de traspasos es
 * (tipo 41, SERIE, folio): la recepción UA50 guarda c37=tipo/c38=serie/c39=folio del
 * origen, y el mismo nº de folio se repite entre sucursales/series (verificado:
 * tres "0000296" distintos). Sin la serie el match es ambiguo.
 *
 * Idempotente (hasColumn). analytics.* sin RLS.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('analytics').hasTable('stock_movements');
  if (!has) return; // la crea 20260710160000
  if (!(await knex.schema.withSchema('analytics').hasColumn('stock_movements', 'doc_serie'))) {
    await knex.raw(`ALTER TABLE analytics.stock_movements ADD COLUMN doc_serie text`);
  }
  if (!(await knex.schema.withSchema('analytics').hasColumn('stock_movements', 'parent_serie'))) {
    await knex.raw(`ALTER TABLE analytics.stock_movements ADD COLUMN parent_serie text`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE analytics.stock_movements DROP COLUMN IF EXISTS doc_serie`);
  await knex.raw(`ALTER TABLE analytics.stock_movements DROP COLUMN IF EXISTS parent_serie`);
};
