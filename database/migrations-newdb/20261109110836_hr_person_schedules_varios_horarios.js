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
 * ── Lo medido antes (Mega Talento, sólo lectura, 2026-11-09) ─────────────────────────────────
 *  · 89 personas con varios horarios. El ensayo de la carga dejó FUERA 17 por `person_schedules_rotating_ck`
 *    (`cardinality(shift_starts) <= 3`, de cuando sólo había rotativos deducidos de 2-3 turnos): Mega Talento admite
 *    hasta 4 (`MAX_HORARIOS`). El tope pasa a 4, el mismo de la API.
 *
 * Aditiva e idempotente: la API desplegada no conoce `shifts`, y relajar el tope de 3 a 4 no rompe nada de lo que hay.
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('hr').hasTable('person_schedules'))) return;
  if (!(await knex.schema.withSchema('hr').hasColumn('person_schedules', 'shifts'))) {
    await knex.raw(`ALTER TABLE hr.person_schedules ADD COLUMN shifts jsonb`);
    await knex.raw(`COMMENT ON COLUMN hr.person_schedules.shifts IS 'Fase RH: con 2-4 horarios asignados, [{entrada, salida, comidaMin}]; cada día se mide contra el más cercano a su entrada. NULL = uno solo (mandan shift_starts/ends_at/lunch_minutes).'`);
  }
  await topeDeEntradas(knex, 4);
};

/** Deja `person_schedules_rotating_ck` en `cardinality(shift_starts) <= n` (si ya está así, no toca nada). */
async function topeDeEntradas(knex, n) {
  const actual = (await knex.raw(`
    SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
     WHERE conrelid = 'hr.person_schedules'::regclass AND conname = 'person_schedules_rotating_ck'`)).rows[0]?.d ?? null;
  if (actual && actual.includes(`<= ${n})`)) return;
  await knex.raw(`ALTER TABLE hr.person_schedules DROP CONSTRAINT IF EXISTS person_schedules_rotating_ck`);
  await knex.raw(`ALTER TABLE hr.person_schedules ADD CONSTRAINT person_schedules_rotating_ck CHECK (cardinality(shift_starts) <= ${Number(n)})`);
}

/**
 * Deshace EXACTAMENTE lo que hizo el `up`. ⚠️ El tope vuelve a 3: si ya hay personas con 4 horarios, el `down` falla
 * (23514) en vez de borrarles un horario en silencio — se decide a mano qué hacer con ellas.
 */
exports.down = async function down(knex) {
  if (!(await knex.schema.withSchema('hr').hasTable('person_schedules'))) return;
  await topeDeEntradas(knex, 3);
  await knex.raw(`ALTER TABLE hr.person_schedules DROP COLUMN IF EXISTS shifts`);
};
