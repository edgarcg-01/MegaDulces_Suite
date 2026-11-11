'use strict';
/**
 * `[CANON.6.2]` — Índice parcial `kepler_ods.kdij … WHERE c4 = 'N'` para que la vista
 * `analytics.v_stock_ledger` (migración siguiente, `20261111093820`) lea sólo los movimientos de
 * inventario del kardex y no las 2.1 M filas de `kdij`.
 *
 * POR QUÉ: la vista reemplaza al importer `import-kardex.js` («ningún importer y ningún cron»).
 * Sin índice, cada consulta recorre `kdij` entera.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-11) ────────────────────────────────────────
 *  · `kdij`: 2,155,606 filas, 841 MB; único índice, la PK. Las de género N: 29,310 (1.4 %).
 *  · `count(*) … WHERE c4 = 'N' AND c1 = sucursal`: 1,448 ms en frío, 276 ms en caliente; la vista
 *    completa, 382 ms en caliente.
 *
 * INCLUDE con las columnas que lee la vista: el índice alcanza para responderla sin ir a la tabla
 * cuando el mapa de visibilidad lo permite. Un índice NO es una copia (criterio de `ix_kdii_suc_sku`).
 * CONCURRENTLY + `transaction:false`: el CDC escribe `kdij` en vivo.
 *
 * ⚠️ El aplicador fija `lock_timeout` de 15 s y `kdij` tiene escritura continua: si falla, deja un
 *    índice INVALID. Receta de la skill `entrega` §5: crearlo antes con margen (fuera del aplicador)
 *    y después aplicar esta migración, que lo encuentra hecho.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdij_genero_n ON kepler_ods.kdij (sucursal, c10)
       INCLUDE (c1, c3, c5, c6, c8, c9, c12, c13, c19, c21) WHERE c4 = 'N'`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdij_genero_n`);
};
