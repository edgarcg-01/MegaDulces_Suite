'use strict';
/**
 * `[VEX.5]` — Índice de expresión `kepler_ods.kdud (sucursal, btrim(c2))` para que
 * `analytics.v_route_cartera_erp` deje de recorrer la sucursal entera por cada cliente.
 *
 * POR QUÉ: «Mi ruta» del vendedor (`GET /commercial/vendor-routes/home`) sincroniza el ancla de su
 * cartera Kepler ANTES de leer (`syncErpCarteraForToday`, VK.4): tres consultas sobre la vista por
 * apertura. La vista une `kdud` por `btrim(d.c2) = m.cliente_code`, y el `btrim` impide usar
 * `kdud_pkey (sucursal, c2)`: el plan hace 98 vueltas de ~1.8 ms por ruta (177 de 192 ms).
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-06) ────────────────────────────────────────
 *  · `analytics.ui_usage`: `vendor-routes/home` promedia 990 ms hoy (705 la semana previa),
 *    máximo 4.1 s; 53 aperturas hoy. Ningún 5xx.
 *  · La vista por ruta Kepler (9 rutas, 85–334 clientes): 192–612 ms. La misma consulta con la
 *    unión por índice: 12–30 ms, mismas filas, RFC y teléfono en las 9 (`c2` no trae espacios en
 *    ninguna de las 9 sucursales; el `btrim` se conserva y este índice lo sirve).
 *
 * Un índice NO es una copia (mismo criterio que `ix_kdii_suc_sku`, mig 20260822140100).
 * CONCURRENTLY + `transaction:false`: el CDC escribe `kdud` en vivo; un CREATE INDEX normal
 * bloquearía la réplica. `kdud` tiene ~22 mil filas: segundos.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

// La MISMA expresión que usa la vista: si cambia allá, cambia aquí o el índice deja de aplicar.
exports.up = async function up(knex) {
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdud_suc_btrim_c2 ON kepler_ods.kdud (sucursal, btrim(c2))`,
  );
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdud_suc_btrim_c2`);
};
