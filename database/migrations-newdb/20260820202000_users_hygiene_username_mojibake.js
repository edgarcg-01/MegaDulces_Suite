'use strict';
/**
 * Fase UN.3 — Higiene de datos de usuarios. No toca permisos ni roles.
 *
 * 1) USERNAME EN MAYÚSCULAS = CUENTA MUERTA (bug, no cosmética).
 *    `auth-mt.service` busca con `username: dto.username.toLowerCase().trim()`
 *    contra una comparación case-sensitive de Postgres. El usuario `Superuser`
 *    (Luis Francisco López Gutiérrez, superadmin) nunca puede matchear → su
 *    `last_login_at` está en NULL desde que se creó en abril. Bajarlo a
 *    minúsculas revive la cuenta. `UsersService.normalizeUsername()` ya
 *    lowercasea en create/update, así que esto alinea los datos viejos con la
 *    regla que el código ya aplica.
 *    Solo baja los que NO colisionan con un username existente en minúsculas.
 *
 * 2) MOJIBAKE EN `nombre` (Latin-1 -> UTF-8 mal decodificado al importar de
 *    Wincaja): nombres en MAYÚSCULAS donde los acentos quedaron en minúscula
 *    ('VERóNICA MAGAñA'). La condición exige que el nombre corregido sea
 *    íntegramente mayúsculas, así que NO toca los Title Case legítimos
 *    ('María Selene Olivares González'). Verificado: corrige 5, respeta 3.
 *
 * NO hace (requiere decisión de Edgar, ver reporte):
 *   - Unificar el casing de `nombre` (hoy conviven UPPER y Title Case) — es
 *     cosmético con impacto en UI, no lo decide una migración.
 *   - Backfill de `warehouse_id` desde `warehouse_code` — falta poblar
 *     `commercial.warehouses.kepler_code` (crosswalk vacío).
 *   - Purgar los 3 tenants de prueba — destructivo.
 *   - Resetear la contraseña de los 11 usuarios que comparten el mismo hash
 *     bcrypt — no existe flujo de "cambio obligatorio".
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const dead = await knex.raw(
    `SELECT id, username FROM identity.users WHERE username <> lower(username)`,
  );
  for (const u of dead.rows) {
    const clash = await knex.raw(
      `SELECT 1 FROM identity.users x
        WHERE x.tenant_id = (SELECT tenant_id FROM identity.users WHERE id = ?)
          AND x.username = lower(?) AND x.id <> ?`,
      [u.id, u.username, u.id],
    );
    if (clash.rows.length) {
      console.log(`[users_hygiene] SKIP ${u.username}: ya existe "${u.username.toLowerCase()}" en el tenant`);
      continue;
    }
    await knex.raw(`UPDATE identity.users SET username = lower(username), updated_at = now() WHERE id = ?`, [u.id]);
    console.log(`[users_hygiene] username ${u.username} -> ${u.username.toLowerCase()} (login estaba muerto)`);
  }

  const fixed = await knex.raw(
    `UPDATE identity.users
        SET nombre = translate(nombre, 'áéíóúñ', 'ÁÉÍÓÚÑ'), updated_at = now()
      WHERE nombre IS NOT NULL
        AND nombre <> translate(nombre, 'áéíóúñ', 'ÁÉÍÓÚÑ')
        AND translate(nombre, 'áéíóúñ', 'ÁÉÍÓÚÑ') = upper(translate(nombre, 'áéíóúñ', 'ÁÉÍÓÚÑ'))`,
  );
  console.log(`[users_hygiene] mojibake corregido en nombre: ${fixed.rowCount ?? 0} usuarios`);
};

/**
 * Irreversible por diseño: no guardamos el username ni el nombre original, y
 * revertir el lowercase volvería a matar el login. La corrección de mojibake
 * tampoco tiene inversa determinista (no se sabe qué acento estaba roto).
 *
 * @param { import("knex").Knex } knex
 */
exports.down = async function down() {
  // no-op a propósito
};
