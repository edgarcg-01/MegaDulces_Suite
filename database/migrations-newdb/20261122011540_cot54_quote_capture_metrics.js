'use strict';
/**
 * `[COT.54]` — **Cuánto costó capturar cada cotización.** Tres columnas en `commercial.quotes`:
 * `capture_seconds` (del primer artículo agregado a guardar), `capture_searches` (búsquedas de
 * artículo en esa captura) y `capture_recovered` (si se recuperó de un respaldo, COT.50).
 *
 * Por qué (punto 1 de la auditoría de uso y ML de Cotizaciones, 2026-11-21): para saber si una
 * mejora (la canasta habitual, el buscador que aprende, la IA) ahorra tiempo hay que medir el antes.
 *
 * ── Lo medido antes (sólo lectura, prod) ────────────────────────────────────────────────────
 *  · Imposible medirlo hoy: los renglones de una cotización se guardan en el MISMO segundo
 *    (p90 de 0.02 min entre el primero y el último), porque la bandeja vive en el navegador.
 *  · Entre crearla y mandarla a Kepler pasan 0.4 min (mediana): la captura es lo que tarda.
 *
 * ── Sólo en promedios (decisión de Francisco, 2026-11-22) ────────────────────────────────────
 * Se guarda por cotización y se REPORTA sólo agregado (por sucursal o semana), nunca un ranking
 * por persona. NULL = no medido (las de antes, y las que no salen de «Nueva cotización»).
 *
 * Idempotente. Columnas que aceptan nulo y sin default: en Postgres es cambio de catálogo, no reescribe la tabla.
 *
 * @param { import("knex").Knex } knex
 */

const COLUMNAS = [
  ['capture_seconds', 'integer CHECK (capture_seconds IS NULL OR capture_seconds >= 0)'],
  ['capture_searches', 'integer CHECK (capture_searches IS NULL OR capture_searches >= 0)'],
  ['capture_recovered', 'boolean'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [col, tipo] of COLUMNAS) {
    if (!(await knex.schema.withSchema('commercial').hasColumn('quotes', col))) {
      await knex.raw(`ALTER TABLE commercial.quotes ADD COLUMN ${col} ${tipo}`);
    }
  }
  await knex.raw(`COMMENT ON COLUMN commercial.quotes.capture_seconds IS
    '[COT.54] Segundos del primer articulo agregado a guardar (Nueva cotizacion). NULL = no medido. Se reporta SOLO agregado, nunca por persona (decision 2026-11-22).'`);
  await knex.raw(`COMMENT ON COLUMN commercial.quotes.capture_searches IS
    '[COT.54] Busquedas de articulo en esa captura. NULL = no medido. Solo agregado.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.quotes.capture_recovered IS
    '[COT.54] La captura se recupero de un respaldo del navegador (COT.50): sus segundos cuentan desde que se recupero; lo de antes del corte no se midio. NULL = no medido.'`);
  console.log('  ✓ [COT.54] commercial.quotes: capture_seconds, capture_searches, capture_recovered (nulas = no medido)');
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita las tres columnas (son nuevas). */
exports.down = async function down(knex) {
  for (const [col] of COLUMNAS) {
    await knex.raw(`ALTER TABLE commercial.quotes DROP COLUMN IF EXISTS ${col}`);
  }
};
