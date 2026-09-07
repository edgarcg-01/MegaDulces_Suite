/**
 * U.5b — el índice parcial de peldaño mezclado, SIN `CONCURRENTLY`.
 *
 * ── Por qué existe esta migración aparte ───────────────────────────────────────────────────
 * La 20260905180000 lo intentó con `CREATE INDEX CONCURRENTLY` (el reflejo correcto en una tabla
 * de 4.46M filas a la que un importer le escribe cada pocos minutos). En ESTA base es una trampa:
 *
 *   `CONCURRENTLY` espera a que terminen TODAS las transacciones más viejas que él, incluso las
 *   que no tocan la tabla. En prod había una consulta de analítica de Kepler corriendo desde
 *   **1h54m** (`WITH vta AS (SELECT d.c3, sum(d.c9) …`, 3 workers paralelos), así que el build se
 *   quedó 575 s en `Lock/virtualxid` — y como toma SHARE UPDATE EXCLUSIVE, encoló detrás DOS
 *   `ANALYZE analytics.sales_daily` del propio importer. El remedio de no bloquear al importer
 *   terminó bloqueándolo.
 *
 * Un `CREATE INDEX` normal NO espera transacciones ajenas: toma el lock y escanea. Con el
 * predicado `WHERE rung_mixed` en falso para el 100% de las filas de hoy, el índice sale vacío y
 * el escaneo es corto. Bloquea escrituras unos segundos, una sola vez.
 *
 * Regla que sale de acá: en esta DB, `CONCURRENTLY` sólo conviene si el índice va a tardar de
 * verdad; para uno que sale vacío, el costo de esperar a los lectores largos es mayor que el
 * lock. Y antes de lanzarlo, mirar `pg_stat_activity` por transacciones viejas.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  // Cota dura: si alguien tiene la tabla tomada, esta migración FALLA rápido en vez de sentarse
  // sobre la cola de escritura del importer.
  await knex.raw("SET LOCAL lock_timeout = '15s'");
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_daily_rung_mixed
                    ON analytics.sales_daily (tenant_id, sale_date)
                 WHERE rung_mixed`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS analytics.ix_sales_daily_rung_mixed');
};
