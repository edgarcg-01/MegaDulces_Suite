'use strict';
/**
 * `[RH.1.15]` Fase RH (ADR-084) — **varios horarios por persona** (hasta 4: mañana, tarde…).
 * Traslado de `mega-talento-90/api/db/horario-asignado.sql` @ 8396d3c (15/10/2026), que agrega
 * `horarios_confirmados.horarios jsonb`.
 *
 * Piso de venta trabaja unos días en un horario y otros en otro. Con uno solo, los días del otro
 * turno salían como retardo. Ahora cada día se mide contra el que trabajó: el más cercano a la hora
 * en que checó su entrada (`asistencia-persona.ts`).
 *
 * Forma, IGUAL que Mega Talento para que la carga única copie la columna tal cual:
 *  · `shifts` = `[{entrada, salida, comidaMin}, …]` SÓLO cuando son 2 o más. Con uno solo queda NULL
 *    y mandan `shift_starts`/`ends_at`/`lunch_minutes`, como siempre.
 *  · Con varios, `shift_starts` lleva TODAS sus entradas y `ends_at`/`lunch_minutes` las del primero
 *    (quien lea sólo esas columnas sigue viendo algo coherente).
 *
 * El CHECK `person_schedules_rotating_ck` pasa de ≤ 3 a ≤ 4: Mega Talento admite hasta 4 horarios
 * (`router.ts::MAX_HORARIOS`) y con 4 la carga única chocaría contra el tope viejo.
 *
 * ── Orden ───────────────────────────────────────────────────────────────────────────────────
 *  · ⚠️ ANTES del código: el lector (`attendance-reader.ts::confirmados`) SELECCIONA `shifts`; con el
 *    código desplegado y la columna ausente, la asistencia de todo sitio responde 500.
 *  · ANTES de la carga única: la carga escribe `shifts`.
 *  · `hr.person_schedules` es chica (una fila por persona con horario confirmado): agregar una
 *    columna NULL sin default no reescribe la tabla y el CHECK nuevo se valida sobre pocas filas.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('hr').hasColumn('person_schedules', 'shifts'))) {
    await knex.raw(`ALTER TABLE hr.person_schedules ADD COLUMN shifts jsonb`);
  }
  await knex.raw(`ALTER TABLE hr.person_schedules DROP CONSTRAINT IF EXISTS person_schedules_shifts_ck`);
  await knex.raw(`
    ALTER TABLE hr.person_schedules ADD CONSTRAINT person_schedules_shifts_ck
      CHECK (shifts IS NULL OR (jsonb_typeof(shifts) = 'array' AND jsonb_array_length(shifts) BETWEEN 2 AND 4))`);
  await knex.raw(`ALTER TABLE hr.person_schedules DROP CONSTRAINT IF EXISTS person_schedules_rotating_ck`);
  await knex.raw(`
    ALTER TABLE hr.person_schedules ADD CONSTRAINT person_schedules_rotating_ck
      CHECK (cardinality(shift_starts) <= 4)`);
  await knex.raw(`COMMENT ON COLUMN hr.person_schedules.shifts IS
    'Con 2-4 horarios: [{entrada, salida, comidaMin}, ...]; cada día se mide contra el más cercano a su entrada. Con uno solo, NULL (manda shift_starts/ends_at/lunch_minutes). Antes horarios_confirmados.horarios.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE hr.person_schedules DROP CONSTRAINT IF EXISTS person_schedules_shifts_ck`);
  await knex.raw(`ALTER TABLE hr.person_schedules DROP CONSTRAINT IF EXISTS person_schedules_rotating_ck`);
  // Si alguien ya guardó 4 entradas, volver al tope de 3 FALLA aquí a propósito: mejor que el
  // down lo diga a que borre horarios en silencio.
  await knex.raw(`
    ALTER TABLE hr.person_schedules ADD CONSTRAINT person_schedules_rotating_ck
      CHECK (cardinality(shift_starts) <= 3)`);
  if (await knex.schema.withSchema('hr').hasColumn('person_schedules', 'shifts')) {
    await knex.raw(`ALTER TABLE hr.person_schedules DROP COLUMN shifts`);
  }
};
