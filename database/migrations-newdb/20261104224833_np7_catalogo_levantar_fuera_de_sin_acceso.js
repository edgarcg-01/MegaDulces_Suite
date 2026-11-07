'use strict';
/**
 * `[NP.7.L.7b]` — Quita `CATALOGO_LEVANTAR` del rol `sin_acceso`.
 *
 * La migración que repartió la clave «a todo rol con personas» (`20261102235243_np7_catalogo_levantar_a_todos.js`)
 * excluyó los roles retirados, el cliente del portal, la cuenta de los feeds y las cuentas compartidas de
 * dispositivo, pero se le pasó `sin_acceso`: un rol que, por su nombre, existe para que su gente NO entre a
 * nada. Darle una clave lo contradice, y en cuanto alguien caiga en ese rol podría levantar fichas.
 *
 * ── Lo medido antes (sólo lectura contra prod, 2026-11-04) ──────────────────────────────────
 *  · 38 filas de `role_permissions` con `CATALOGO_LEVANTAR = true` (control: igual que el 2026-11-03).
 *  · `sin_acceso` (tenant mega_dulces) la tiene en `true`, con 0 personas activas por rol principal y 0 por
 *    rol complementario: quitarla no le cambia el acceso a nadie hoy.
 *  · Ningún preset de código (`libs/contracts/src/authz`) nombra a `sin_acceso`: nada la vuelve a poner.
 *
 * ⚠️ Sólo hace UPDATE (no crea esquema): la compuerta del despliegue la clasifica NO_MEDIDO y se aplica a
 *    mano con `apply-one-migration-prod.js`, ANTES de mergear.
 *
 * Idempotente: si la clave ya no está, no toca nada. Al final VERIFICA que `sin_acceso` no la tenga en
 * ningún tenant; si la tiene, falla en vez de reportar éxito.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'CATALOGO_LEVANTAR';
const ROL = 'sin_acceso';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const r = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - ?::text
      WHERE role_name = ?
        AND permissions -> ?::text IS NOT NULL`,
    [CLAVE, ROL, CLAVE],
  );
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS quedan FROM identity.role_permissions WHERE role_name = ? AND permissions -> ?::text IS NOT NULL`,
    [ROL, CLAVE],
  );
  // eslint-disable-next-line no-console
  console.log(`  [NP.7.L.7b] ${CLAVE} fuera de ${ROL}: ${r.rowCount} fila(s) tocadas · quedan ${rows[0].quedan}`);
  if (rows[0].quedan !== 0) throw new Error(`[NP.7.L.7b] ${ROL} sigue con ${CLAVE}: revisar role_permissions.`);
};

/**
 * Deshace el `up` devolviéndole la clave en `true` a `sin_acceso`, como la dejó la migración de L.7b. No es
 * un inverso exacto: el `up` no recuerda si estaba en `false`. Sólo donde falta (si alguien la puso a mano en
 * `false` después, no se pisa).
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true)
      WHERE role_name = ?
        AND permissions -> ?::text IS NULL`,
    [CLAVE, ROL, CLAVE],
  );
};
