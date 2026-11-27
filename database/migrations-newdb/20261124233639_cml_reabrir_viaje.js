'use strict';
/**
 * `[CML.K]` Reabrir un viaje cerrado, con motivo.
 *
 * El viaje se cierra UNA vez en Embarques › Cerrar viajes (tripulación + horario → comisión y
 * viático) y Pagos de viaje queda como historial SIN edición. Pero un ayudante equivocado o una
 * hora mal puesta pasan: si no hay forma de corregir dentro de la Suite, se corrige por fuera y la
 * Suite deja de cuadrar. Reabrir borra el horario y los montos calculados (la guía vuelve a «falta
 * el horario» y el pago la retiene) y deja aquí quién, cuándo y POR QUÉ.
 *
 * ── Lo medido antes ──────────────────────────────────────────────────────────────────────────
 *  · Hoy no hay ningún camino para corregir una guía completada (EMB.22: «se guarda una vez»).
 *
 * Guarda la ÚLTIMA reapertura (columna + quién/cuándo, como pidió el PM en E4: columna en vez de
 * tabla nueva). Sólo columnas nulas: ningún camino que inserta guías cambia (regla 14).
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'delivery_guides';
const COLUMNAS = {
  reopened_at: (t) => t.timestamp('reopened_at', { useTz: true }).nullable(),
  reopened_by: (t) => t.uuid('reopened_by').nullable(),
  reopen_reason: (t) => t.text('reopen_reason').nullable(),
};

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const faltan = [];
  for (const c of Object.keys(COLUMNAS)) {
    if (!(await knex.schema.withSchema('logistics').hasColumn(TABLA, c))) faltan.push(c);
  }
  if (faltan.length) {
    await knex.schema.withSchema('logistics').alterTable(TABLA, (t) => { for (const c of faltan) COLUMNAS[c](t); });
  }
  await knex.raw(`COMMENT ON COLUMN logistics.delivery_guides.reopen_reason IS
    '[CML.K] Por qué se reabrió el viaje (la última vez). Reabrir borra horario y montos calculados; la guía vuelve a capturarse.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const hay = [];
  for (const c of Object.keys(COLUMNAS)) {
    if (await knex.schema.withSchema('logistics').hasColumn(TABLA, c)) hay.push(c);
  }
  if (hay.length) await knex.schema.withSchema('logistics').alterTable(TABLA, (t) => { for (const c of hay) t.dropColumn(c); });
};
