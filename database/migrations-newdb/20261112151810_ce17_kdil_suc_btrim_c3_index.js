'use strict';
/**
 * `[CE.1.7]` — Índice de expresión `kepler_ods.kdil (sucursal, btrim(c3))` para leer la existencia
 * de Kepler de UNA celda (almacén × producto) sin recorrer la sucursal entera.
 *
 * POR QUÉ: «Por vencer» deja de leer lo «sin fecha» de la copia que escribe el importer
 * `import-branch-stock-live` (`commercial.stock` → lote `NA` por trigger; cuadra 91 % contra el POS,
 * CANON §8 renglón 2) y lo deriva del ODS: existencia de `analytics.v_erp_stock_on_hand` (vista sobre
 * `kdil`, cuadra 100 %) menos lo fechado de la celda. La vista une `kdil` por `btrim(k.c3) = sku`, y el
 * `btrim` impide usar `kdil_pkey (sucursal, c1, c2, c3)`.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-12) ────────────────────────────────────────
 *  · La existencia ODS de los 73 lotes por celda: 492 ms; el plan recorre ~4,535 renglones de `kdil`
 *    por celda (Bitmap Heap Scan por `sucursal, c1`). `kdil`: 40,571 renglones, 0 con `c3` con espacios.
 *
 * Un índice NO es una copia (mismo criterio que `ix_kdud_suc_btrim_c2` y `ix_kdik_suc_btrim_c2`).
 * CONCURRENTLY + `transaction:false`: el ODS escribe `kdil` en vivo. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

// La MISMA expresión que usa `analytics.v_erp_stock_on_hand` (btrim(k.c3)): si cambia allá, cambia aquí.
exports.up = async function up(knex) {
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdil_suc_btrim_c3 ON kepler_ods.kdil (sucursal, btrim(c3))`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdil_suc_btrim_c3`);
};
