'use strict';
/**
 * Fase RH · frente NE · `[NE.2.5]` — UN ALIAS RESUELTO A MANO NO EXISTE SIN FIRMA.
 *
 * `hr.person_aliases` nació en `[NE.0.4]` y su propio comentario de columna ya lo decía:
 *
 *     'llave = los dos sistemas comparten un código · nombre = empate textual, PROVISIONAL ·
 *      manual = alguien lo decidió y **firmó en matched_note**.'
 *
 * ⛔ Pero nadie lo exigía. El `CHECK` que pide nota (`person_aliases_nombre_ck`) cubre sólo
 * `matched_by = 'nombre'`: un alias `'manual'` podía entrar **sin nota y sin autor**, y entonces
 * «alguien lo decidió» es exactamente lo que no se puede averiguar después. Una regla escrita en
 * un comentario y no ejecutada es una intención, no una regla.
 *
 * Esto importa más acá que en otras tablas: **un alias dice a quién se le paga**. Resolver un caso
 * a mano es decir «este código de nómina es esta persona»; si eso entra sin quién lo dijo y por
 * qué, el error es indistinguible del acierto y no hay a quién preguntarle.
 *
 * ── Lo que exige, para `matched_by = 'manual'` ────────────────────────────────────────────────
 *  · `matched_note` presente y **no en blanco** (el porqué, en palabras);
 *  · `created_by` presente (**quién lo decidió**).
 *
 * ⚠️ Lo de `'nombre'` **no se toca**: `[NE.2.3]` le escribe una nota generada y ese camino ya
 * funciona. Queda anotado que ese `CHECK` acepta la cadena vacía —`IS NOT NULL` pasa con `''`—;
 * no se estrecha acá porque estrechar un `CHECK` ajeno al item es cambiarle el alcance a otro.
 *
 * ── Por qué se puede aplicar sin miedo ────────────────────────────────────────────────────────
 * Medido en prod (sólo lectura, `system_identifier` verificado, 2026-11-25): `hr.person_aliases`
 * tiene **0 filas**, así que ninguna fila existente puede quedar inválida. Aun así el `up` cuenta
 * las filas que violarían la regla **antes** de agregar la restricción y se niega con el número,
 * en vez de reventar con un error de Postgres que no dice cuántas son.
 *
 * ⚠️ Esta migración ESTRECHA lo que la tabla acepta. Por la regla «una migración nunca exige lo
 * que la API desplegada no manda»: el código desplegado hoy (`[NE.2.3]`) **sólo escribe
 * `matched_by = 'nombre'`**, que esta restricción ni mira. El primer `'manual'` lo escribe el
 * servicio de la cola, que viaja en el mismo commit que esta migración.
 *
 * Idempotente: se puede correr dos veces y la segunda deja lo mismo.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'person_aliases';
const CK = `${T}_manual_firma_ck`;
const REGLA = `matched_by <> 'manual'
               OR (matched_note IS NOT NULL AND btrim(matched_note) <> '' AND created_by IS NOT NULL)`;

/** ¿Ya está la restricción? Se lee del catálogo, no se supone. */
async function yaEsta(knex) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conrelid = 'hr.${T}'::regclass AND conname = ?`,
    [CK],
  );
  return rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await yaEsta(knex)) {
    console.log(`  [ne25] hr.${T} ya exige firma en los alias manuales: nada que hacer.`);
    return;
  }

  // Se cuenta ANTES: un error de Postgres diría «violates check constraint» sin decir cuántas.
  const { rows: [m] } = await knex.raw(
    `SELECT count(*)::int AS n FROM hr.${T}
      WHERE matched_by = 'manual'
        AND (matched_note IS NULL OR btrim(matched_note) = '' OR created_by IS NULL)`,
  );
  if (m.n > 0) {
    throw new Error(
      `[ne25] hay ${m.n} alias 'manual' sin nota o sin autor. Esta migración los dejaría inválidos. ` +
        `Decidí primero quién los firma: no se pueden rellenar inventando un autor.`,
    );
  }

  await knex.raw(`ALTER TABLE hr.${T} ADD CONSTRAINT ${CK} CHECK (${REGLA})`);
  await knex.raw(`COMMENT ON COLUMN hr.${T}.matched_by IS
    'llave = los dos sistemas comparten un código · nombre = empate textual, PROVISIONAL · manual = alguien lo decidió, y la base EXIGE su nota (el porqué) y su created_by (quién): person_aliases_manual_firma_ck.'`);
  console.log(`  [ne25] hr.${T}: un alias 'manual' ahora exige nota y autor.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. Aflojar nunca invalida filas. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE hr.${T} DROP CONSTRAINT IF EXISTS ${CK}`);
  await knex.raw(`COMMENT ON COLUMN hr.${T}.matched_by IS
    'llave = los dos sistemas comparten un código · nombre = empate textual, PROVISIONAL · manual = alguien lo decidió y firmó en matched_note.'`);
};
