'use strict';
/**
 * `[IDG.9.12]` — Una etiquetera no fuerza cambio de contraseña.
 *
 * Al verificar el estado final de `[IDG.9.12]` apareció que `etiquetas.04`
 * (creada a mano el 2026-09-03) traía `must_change_password = true`. Es
 * exactamente el modo de falla que la convención de estas cuentas evita: son
 * credenciales de PUESTO, compartidas por el turno, y si la app fuerza el
 * cambio, **la primera persona la cambia y el resto del turno queda afuera** —
 * sin manera de recuperarla salvo pedirle un reseteo a Sistemas.
 *
 * Es una excepción acotada y con motivo, no una política general: para una
 * cuenta de persona el `must_change_password` es lo correcto.
 *
 * Se separa de `20260908140000_etiqueteras_rol_y_convencion.js` en vez de
 * agregarse ahí porque esa ya está aplicada en prod (batch 336), y una migración
 * aplicada no se edita.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const r = await knex.raw(
    `UPDATE identity.users
        SET must_change_password = false, updated_at = now()
      WHERE username ~ '^etiquetas[.][0-9]{2}$' AND deleted_at IS NULL
        AND must_change_password`,
  );
  console.log(`  ✓ ${r.rowCount} etiquetera(s) dejan de forzar cambio de contrasena.`);

  const { rows: g } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.users
      WHERE username ~ '^etiquetas[.][0-9]{2}$' AND deleted_at IS NULL AND must_change_password`,
  );
  if (g[0].n > 0) throw new Error(`Quedan ${g[0].n} etiquetera(s) forzando cambio de contrasena.`);
};

exports.down = async function down() {
  console.log(
    '  down() no revierte: volver a forzar el cambio dejaria al turno afuera en cuanto la primera persona la cambie.',
  );
};
