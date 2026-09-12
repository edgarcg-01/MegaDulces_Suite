/**
 * DROP de 2 tablas dated de estadísticas de pgboss (snapshots manuales obsoletos).
 *
 * Verificado contra prod 2026-09-11: **0 filas + 0 referencias en código vivo + 0 FKs entrantes**.
 * No son objetos que administre la librería pg-boss (su schema no crea tablas con fecha en el
 * nombre); fueron snapshots manuales que quedaron. En el server nuevo pg-boss arranca limpio, así
 * que el DROP IF EXISTS es no-op allá. Sin CASCADE (no hay dependencias). `down` = no-op.
 *
 *   pgboss.queue_stats_20260813
 *   pgboss.queue_stats_20260814
 * @param { import("knex").Knex } knex
 */
const DATED = ['pgboss.queue_stats_20260813', 'pgboss.queue_stats_20260814'];

exports.up = async function (knex) {
  for (const t of DATED) {
    await knex.raw(`DROP TABLE IF EXISTS ${t}`);
    console.log(`  DROP ${t}`);
  }
};

exports.down = async function () {
  // Snapshots dated obsoletos: no se recrean. No-op a propósito.
};
