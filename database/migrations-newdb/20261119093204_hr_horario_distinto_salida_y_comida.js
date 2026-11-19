'use strict';
/**
 * `[RH.17.2]` — «Horario distinto» con SALIDA y COMIDA de ese día (opcionales).
 *
 * «Horario distinto» (HD) es la incidencia de UN solo día con su porqué y quién lo autorizó, pero sólo guardaba la
 * ENTRADA (`minutes`; `base_schedule_minutes` es la entrada de siempre, para la bandera de corrimiento). Un día de otra
 * duración (p. ej. de 8:00 a 14:00) no se podía capturar: se medía con la salida de su horario permanente. Con estas
 * dos columnas, ese día se mide de la entrada a la salida capturadas. El horario permanente (`hr.person_schedules`)
 * no se toca.
 *
 *   · end_minutes    salida de ese día, minuto del día (840 = 14:00). NULL = como hasta hoy (sólo mueve la entrada).
 *   · break_minutes  comida autorizada ese día, en minutos (0-240). NULL = la de su horario.
 *
 * Son datos propios (los captura RH), no del ERP. Nullable: ningún camino que inserta en la tabla cambia (regla 14).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-19) ────────────────────────────────────────
 *  · HD por mes: sep 66 · oct 79 (2 anuladas) · nov 1. Ninguna nota menciona la salida: el pedido viene de RH, no
 *    de un patrón en los datos.
 *  · Las dos columnas no existen en prod.
 *
 * La API las usa sólo si existen (`attendance-incidents.service.ts`): si llega a prod antes que esta migración, la
 * asistencia no se cae; capturar una salida contesta que falta aplicarla.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'hr.attendance_incidents';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const hay = async (col) => knex.schema.withSchema('hr').hasColumn('attendance_incidents', col);
  if (!(await hay('end_minutes'))) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN end_minutes integer
      CONSTRAINT attendance_incidents_end_minutes_ck CHECK (end_minutes IS NULL OR (end_minutes BETWEEN 0 AND 1439))`);
    await knex.raw(`COMMENT ON COLUMN ${TABLA}.end_minutes IS '[RH.17.2] Horario distinto: salida de ese día, minuto del día. NULL = sólo mueve la entrada.'`);
  }
  if (!(await hay('break_minutes'))) {
    await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN break_minutes integer
      CONSTRAINT attendance_incidents_break_minutes_ck CHECK (break_minutes IS NULL OR (break_minutes BETWEEN 0 AND 240))`);
    await knex.raw(`COMMENT ON COLUMN ${TABLA}.break_minutes IS '[RH.17.2] Horario distinto: comida autorizada ese día, en minutos. NULL = la de su horario.'`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN IF EXISTS break_minutes`);
  await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN IF EXISTS end_minutes`);
};
