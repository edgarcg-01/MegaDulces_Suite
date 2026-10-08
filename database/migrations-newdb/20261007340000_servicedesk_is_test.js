'use strict';
/**
 * `[MS.7.12]` — Tickets de PRUEBA. `FASE_MS7_MANTENIMIENTO.md` (decisión M8).
 *
 * Hoy los tickets de prueba de TI (el «Prueba de tickets», SRV-2026-00003) cuentan en los reportes y el tablero, y se limpian a mano.
 * `requests.is_test` los marca. Lo marca LA COORDINACIÓN desde la ficha (queda en el hilo) y desde ahí se EXCLUYE de reportes, tablero,
 * carga por persona, «Mi trabajo», barrido del SLA y avisos. NO se excluye de la bandeja: la coordinación tiene que poder encontrarlo
 * para quitarle la marca.
 *
 * Aditiva, idempotente y reversible. `NOT NULL DEFAULT false`: todo ticket existente queda como «no es de prueba» — nada cambia hasta
 * que alguien lo marque. Índice PARCIAL sobre los marcados (son pocos; el filtro normal es `is_test = false`, que no lo necesita).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const tiene = await knex.schema.withSchema('servicedesk').hasColumn('requests', 'is_test');
  if (!tiene) await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN is_test boolean NOT NULL DEFAULT false`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_requests_is_test ON servicedesk.requests (tenant_id, id) WHERE is_test`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.is_test IS 'MS.7.12 — ticket de prueba (lo marca la coordinación). No cuenta en reportes, tablero, carga, Mi trabajo, barrido del SLA ni avisos; sí aparece en la bandeja para poder quitarle la marca.'`);
  // eslint-disable-next-line no-console
  console.log(`  [MS.7.12] requests.is_test ${tiene ? 'ya existía' : 'agregada (todo ticket existente queda en false)'}`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS servicedesk.ix_sd_requests_is_test`);
  await knex.raw(`ALTER TABLE servicedesk.requests DROP COLUMN IF EXISTS is_test`);
};
