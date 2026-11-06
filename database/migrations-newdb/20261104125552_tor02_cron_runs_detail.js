'use strict';
/**
 * `[TOR.0.2]` — **El latido dice su dato con estructura, no en texto libre.** Agrega
 * `analytics.cron_runs.detail jsonb` (nullable, sin default).
 *
 * Por qué: la torre de Sistemas necesita, por servidor Kepler, segundos de réplica, errores de
 * réplica, WAL retenido, tablas publicadas y arranque. Hoy sólo podría sacarlos parseando `note`
 * («réplica 4 s · 3 errores …»), que es como el bloque de versión de db-health terminó leyendo un
 * commit con una regex. El primer escritor es `store_poller` (`kepler_server_<código>`).
 *
 * ── Lo medido antes (sólo lectura, prod 7688376744939610156, 2026-11-04) ───────────────────
 *  · `analytics.cron_runs` tiene 12 columnas, ninguna estructurada; 110 latidos.
 *
 * ⛔ Compatible con lo desplegado (expand): nullable y sin default → nadie que inserte hoy tiene
 *    que mandarla, y `ADD COLUMN` así sólo toca el catálogo. El poller la escribe **sólo si existe**
 *    (lo pregunta al arrancar), así que el orden de despliegue no rompe su latido.
 * ⚠️ La tabla se escribe sin parar: `lock_timeout` corto para no encolar a los escritores.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tiene = await knex.schema.withSchema('analytics').hasColumn('cron_runs', 'detail');
  if (!tiene) {
    await knex.raw(`ALTER TABLE analytics.cron_runs ADD COLUMN detail jsonb`);
  }
  await knex.raw(`COMMENT ON COLUMN analytics.cron_runs.detail IS
    '[TOR.0.2] Dato estructurado del latido (p. ej. por servidor Kepler: replica_s, errores_replica, retenido_max_bytes, publicadas, arranque). Nullable: el texto sigue en note.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE analytics.cron_runs DROP COLUMN IF EXISTS detail`);
};
