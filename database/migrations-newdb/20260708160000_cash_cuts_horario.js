/**
 * SM.7 — Eje horario del corte (Supervisor de Movimientos).
 *
 * Agrega hora de apertura/cierre y duración del turno a analytics.cash_cuts,
 * para poder deducir CUÁNDO y en qué CIRCUNSTANCIA descuadra un corte
 * (cambio de turno 15:00/18:00, turnos >10h). Kepler: c6=hora_ap, c11=hora_ci.
 * `handoff` = quien abre ≠ quien cierra (columna generada, solo lectura).
 *
 * Aditiva + idempotente. analytics.* sin RLS.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('cash_cuts'))) return;
  const add = async (col, type) => {
    if (!(await knex.schema.withSchema('analytics').hasColumn('cash_cuts', col))) {
      await knex.raw(`ALTER TABLE analytics.cash_cuts ADD COLUMN ${col} ${type}`);
    }
  };
  await add('hora_apertura', 'text');      // c6 'HH:MM:SS'
  await add('hora_cierre', 'text');        // c11 'HH:MM:SS.ss'
  await add('duracion_horas', 'numeric');  // cierre − apertura (h)
  await add('handoff', "boolean GENERATED ALWAYS AS (cajero_apertura IS DISTINCT FROM cajero_cierre) STORED"); // cambio de cajero
};

exports.down = async function () { /* aditiva; no drop */ };
