'use strict';
/**
 * Fase RH · frente NE · `[NE.0.13]` — EL ALIAS APUNTABA A UN PADRÓN QUE NO EXISTE.
 *
 * Corrige un defecto de `20261123100533_ne04_periodos_de_nomina_y_alias_de_persona.js`
 * (de ayer, ya aplicada en prod): `hr.person_aliases.employee_id` es **NOT NULL** y apunta a
 * `hr.employees`. Esa tabla **nunca recibió una fila** — y no es que esté esperando turno: el
 * proyecto ya decidió no usarla.
 *
 * ── Lo medido antes (sólo lectura contra prod, 2026-11-24, `system_identifier` verificado) ──
 *  · `hr.employees` ....... 0 filas y **`n_tup_ins = 0`**: cero inserciones en toda su vida
 *    (existe desde el 2026-08-17). ⛔ El cero está AUDITADO, no supuesto: leyendo con un rol
 *    sin `bypassrls`, las tablas vecinas del mismo schema y la misma RLS forzada sí se cuentan
 *    (`hr.device_enrollments` 2,180 · `hr.person_site_profiles` 1,087 · `identity.users` 1,267),
 *    y `n_tup_ins` lo cuenta el planificador, no la política: no hay filas escondidas.
 *  · Su único camino de carga es `database/importers/checadores/link-employees.js`, **un
 *    importer** — justo lo que la regla 1 prohíbe. Por eso nunca corrió ni va a correr.
 *  · ⭐ El padrón SÍ existe, en otro lado: `[RH.1.4]` ✅ (aplicada en prod el 11-nov) cargó
 *    1,038 personas a **`identity.users`** y sus 1,087 fichas de plaza a
 *    `hr.person_site_profiles`. El padrón de personas de esta suite es `identity.users`.
 *  · Consecuencia exacta: con un FK NOT NULL contra una tabla de 0 filas, `hr.person_aliases`
 *    **no puede recibir ni una sola fila**. La tabla que inventamos ayer para registrar CÓMO se
 *    ligó cada persona nace inutilizable.
 *  · No hay nada que migrar ni nada que romper: `hr.person_aliases` tiene 0 filas, y ningún
 *    `.ts` de `libs/` ni `apps/` la lee o la escribe (sólo la nombra un comentario en
 *    `libs/hr/src/lib/nomina/periodo.ts`). La API desplegada no la conoce.
 *
 * Qué hace: la columna pasa a llamarse `user_id` y apunta a `identity.users` — el padrón que de
 * verdad existe. El nombre cambia con el destino **a propósito**: un `employee_id` que apunta a
 * `identity.users` sería una mentira en el esquema, y el resto de `hr.*` ya dice `user_id`
 * (`hr.device_enrollments.user_id`). El FK va por **`(tenant_id, user_id)`** contra el único
 * compuesto `users_tenant_id_composite` (medido: existe), no por `id` solo: así un alias no puede
 * nombrar a una persona de otro tenant. Lo demás de la tabla —`matched_by` NOT NULL, el CHECK de
 * que un empate por nombre lleve nota, el único por `(system, external_code)`— queda intacto: eso
 * estaba bien y es lo que impide que un empate por nombre se vuelva verdad en silencio.
 *
 * ⚠️ **NO MEDIDO**: que Postgres acepte esta DDL. El Docker local no levanta (el demonio no
 *    responde) y el ensayo con ROLLBACK contra prod quedó sin autorización. Probado **en seco**
 *    con un `knex` que sólo anota el SQL: 5 de 5 —el `up`, el `up` corrido dos veces, el `down`,
 *    y las dos negativas de que `up` y `down` **paran** si la tabla trae filas—. Antes de
 *    aplicarla en prod, corre contra una base de verdad.
 *
 * ⛔ `hr.employees` NO se borra (regla 5). Queda como estaba, con sus dos FKs de compatibilidad
 *    desde `hr.device_enrollments` y `hr.attendance_logs`. Retirarla es una decisión aparte.
 *
 * Idempotente: se puede correr dos veces y la segunda no hace nada.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'person_aliases';

/** ¿Existe esa columna en `hr.person_aliases`? */
async function tieneColumna(knex, col) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'hr' AND table_name = ? AND column_name = ?`,
    [T, col],
  );
  return rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await tieneColumna(knex, 'employee_id'))) {
    console.log(`  [ne013] hr.${T}.employee_id ya no existe: nada que hacer.`);
    return;
  }

  // ⛔ Candado: si alguien logró meter filas, parar en vez de adivinar a qué usuario corresponden.
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int AS n FROM hr.${T}`);
  if (n.n > 0) {
    throw new Error(
      `[ne013] hr.${T} tiene ${n.n} fila(s). Esta migración se escribió para una tabla vacía ` +
        `(medido: 0 filas en prod el 2026-11-24). Revisá a mano a qué persona apunta cada una ` +
        `antes de repuntar el FK.`,
    );
  }

  await knex.raw(`ALTER TABLE hr.${T} DROP CONSTRAINT IF EXISTS ${T}_employee_fk`);
  await knex.raw(`DROP INDEX IF EXISTS hr.ix_${T}_empleado`);
  await knex.raw(`ALTER TABLE hr.${T} RENAME COLUMN employee_id TO user_id`);
  // ⭐ El FK va por (tenant_id, user_id) contra el único compuesto `users_tenant_id_composite`,
  //    no por `id` solo: así un alias NO puede nombrar a una persona de otro tenant. Es la misma
  //    forma que ya usan `hr.device_enrollments` y `hr.attendance_logs`.
  await knex.raw(`
    ALTER TABLE hr.${T}
      ADD CONSTRAINT ${T}_user_fk FOREIGN KEY (tenant_id, user_id)
      REFERENCES identity.users(tenant_id, id) ON DELETE RESTRICT`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${T}_usuario ON hr.${T} (tenant_id, user_id)`);

  await knex.raw(`COMMENT ON COLUMN hr.${T}.user_id IS
    'La persona, en el padrón que de verdad existe: identity.users (1,038 cargadas por [RH.1.4]). ' ||
    'Antes apuntaba a hr.employees, que nunca recibió una fila y cuyo único cargador es un importer.'`);
  await knex.raw(`COMMENT ON TABLE hr.${T} IS
    '[NE.0.4] Cómo nombra cada sistema a la misma persona. matched_by dice CÓMO se ligó: un empate ' ||
    'por nombre queda marcado como tal y se puede auditar y reemplazar por una llave real. ' ||
    '[NE.0.13] Apunta a identity.users, no a hr.employees.'`);

  console.log(`  [ne013] hr.${T}.employee_id -> user_id, ahora contra identity.users. Ya se puede llenar.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await tieneColumna(knex, 'user_id'))) return;
  const { rows: [n] } = await knex.raw(`SELECT count(*)::int AS n FROM hr.${T}`);
  if (n.n > 0) {
    throw new Error(
      `[ne013] down: hr.${T} tiene ${n.n} fila(s) y hr.employees no las puede recibir. ` +
        `Vaciala a mano si de verdad querés volver atrás.`,
    );
  }
  await knex.raw(`ALTER TABLE hr.${T} DROP CONSTRAINT IF EXISTS ${T}_user_fk`);
  await knex.raw(`DROP INDEX IF EXISTS hr.ix_${T}_usuario`);
  await knex.raw(`ALTER TABLE hr.${T} RENAME COLUMN user_id TO employee_id`);
  await knex.raw(`
    ALTER TABLE hr.${T}
      ADD CONSTRAINT ${T}_employee_fk FOREIGN KEY (employee_id)
      REFERENCES hr.employees(id) ON DELETE RESTRICT`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_${T}_empleado ON hr.${T} (tenant_id, employee_id)`);
};
