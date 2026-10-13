'use strict';
/**
 * `[EMB.24]` — Índice para encontrar la RECEPCIÓN de un traspaso (U-A-50) desde su embarque.
 *
 * La vista `analytics.erp_shipment_stop_closure` (migración anterior) cierra cada parada de
 * traspaso con la recepción que captura la sucursal destino: `U-A-50` con `c37=41` (grupo del
 * padre), `c38=serie` y `c39=folio` del embarque (ERP_KEPLER §3.y). En `kepler_ods.kdm1` no hay
 * índice que sirva a esa búsqueda: los existentes son de documentos `U-D` y `X-A`.
 *
 * ── Lo medido antes (sólo lectura, prod 2026-10-09) ────────────────────────────────────────
 *  · 981 traspasos en 45 días, 927 (94%) con recepción. El índice es PARCIAL (sólo U-A-50),
 *    así que pesa casi nada y no estorba a la ingesta que escribe `kdm1`.
 *
 * ⚠️ `CONCURRENTLY` no corre dentro de una transacción: por eso `transaction: false`. Las
 *    expresiones deben coincidir EXACTAMENTE con las de la vista para que el planificador lo use.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdm1_recepcion_traspaso
        ON kepler_ods.kdm1 (btrim(sucursal), btrim(c39))
     WHERE c2 = 'U' AND c3 = 'A' AND c4 = 50`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdm1_recepcion_traspaso');
};
