'use strict';
/**
 * `[CE.1.6]` — Índice de expresión `kepler_ods.kdik (sucursal, btrim(c2))` para que el costo de
 * UNA celda (almacén × producto) se resuelva sin recorrer la sucursal entera.
 *
 * POR QUÉ: «Por vencer» (`GET /commercial/inventory/expiring`) necesita el costo de ~73 celdas y
 * hoy paga el resolvedor completo (`analytics.v_erp_unit_cost`, 250,316 celdas, ~1.4 s). La
 * migración hermana (`…_ce16_erp_unit_cost_por_celda`) agrega `analytics.erp_unit_cost_at()`,
 * que busca sólo la celda pedida; su búsqueda en `kdik` es `sucursal = ? AND btrim(c2) = ?`, y el
 * `btrim` impide usar `kdik_pkey (sucursal, c1, c2)`.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-12) ────────────────────────────────────────
 *  · Sin este índice, la búsqueda por celda recorre ~4,400 renglones de la sucursal por lote:
 *    1.1–1.4 s para 73 lotes (no mejora). Con la búsqueda exacta por la llave: 10–25 ms.
 *  · `kdik` tiene 40,556 renglones, se mantiene por upsert (0 borrados): el índice sobrevive.
 *
 * Un índice NO es una copia (mismo criterio que `ix_kdud_suc_btrim_c2`, mig 20261106130728).
 * CONCURRENTLY + `transaction:false`: el ODS escribe `kdik` en vivo. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

// La MISMA expresión que usa `analytics.v_kepler_item_cost` (sucursal, btrim(c2)): si cambia allá, cambia aquí.
exports.up = async function up(knex) {
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdik_suc_btrim_c2 ON kepler_ods.kdik (sucursal, btrim(c2))`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdik_suc_btrim_c2`);
};
