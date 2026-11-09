'use strict';
/**
 * Fase RH · `[RH.6.3]` — VARIOS HORARIOS POR PERSONA (Mega Talento 8396d3c, 15/10/2026).
 *
 * Piso de venta trabaja unos días en un horario y otros en otro (mañana / tarde). Con uno solo, los
 * días del otro turno salían como retardo. `shifts` = [{entrada, salida, comidaMin}, …] (hasta 4) y
 * cada día se mide contra el que trabajó: el más cercano a su entrada.
 *
 * Misma forma que en Mega Talento (`horarios_confirmados.horarios`): con un solo horario queda NULL y
 * mandan `shift_starts`/`ends_at`/`lunch_minutes`, como siempre. Con varios, `shift_starts` lleva todas
 * sus entradas y `ends_at`/`lunch_minutes` las del primero, para que quien lea sólo esas columnas siga
 * viendo algo coherente.
 *
 * Aditiva, nullable, idempotente: la API desplegada no la conoce y no la necesita.
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('hr').hasTable('person_schedules'))) return;
  if (!(await knex.schema.withSchema('hr').hasColumn('person_schedules', 'shifts'))) {
    await knex.raw(`ALTER TABLE hr.person_schedules ADD COLUMN shifts jsonb`);
    await knex.raw(`COMMENT ON COLUMN hr.person_schedules.shifts IS 'Fase RH: con 2-4 horarios asignados, [{entrada, salida, comidaMin}]; cada día se mide contra el más cercano a su entrada. NULL = uno solo (mandan shift_starts/ends_at/lunch_minutes).'`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE hr.person_schedules DROP COLUMN IF EXISTS shifts`);
};
