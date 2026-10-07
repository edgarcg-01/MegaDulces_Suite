/**
 * Sprint M.6.3 — FDW para `Mega_Dulces.ranking_productos`.
 *
 * El ERP mantiene un top 1000 productos pre-calculado (posición, total_cajas,
 * total_piezas, total_venta) que es más fiel a la realidad que los rankings
 * de `commercial.orders` (que solo cuentan pedidos levantados por el portal/
 * vendor app, no toda la venta del ERP).
 *
 * Schema `analytics_external` y server `mega_dulces_srv` ya existen del
 * Sprint M.3 (migración 20260601220000). Solo agregamos la foreign table.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE FOREIGN TABLE IF NOT EXISTS analytics_external.ranking_legacy (
      posicion             INTEGER,
      articulo             VARCHAR(20),
      nombre               VARCHAR,
      total_cajas          BIGINT,
      total_piezas         NUMERIC,
      total_piezas_totales NUMERIC,
      total_venta          NUMERIC
    ) SERVER mega_dulces_srv
      OPTIONS (schema_name 'public', table_name 'ranking_productos')
  `);

  await knex.raw(`GRANT SELECT ON analytics_external.ranking_legacy TO app_runtime`);

  console.log('[fdw_mega_dulces_ranking] analytics_external.ranking_legacy creada');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP FOREIGN TABLE IF EXISTS analytics_external.ranking_legacy`);
};
