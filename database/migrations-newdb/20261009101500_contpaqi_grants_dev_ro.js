'use strict';
/**
 * `[CP.8.1b]` — **`dev_ro` también lee `contpaqi.*`.** Corrección de una inconsistencia que
 * dejó la migración anterior.
 *
 * ── Qué pasó ────────────────────────────────────────────────────────────────────────────────
 * `20261008155000` otorgó a `app_runtime` (lo que la API necesita para operar) y **se olvidó de
 * `dev_ro`**. Medido en prod inmediatamente después de aplicarla:
 *
 *     analytics  | t          commercial | t          finance | t          fiscal | t
 *     contpaqi   | f   <-- el único
 *
 * El síntoma es engañoso: `information_schema.tables` **devuelve vacío** en vez de dar error,
 * porque filtra por privilegio. O sea que desde una sesión de desarrollo el schema se ve
 * **inexistente**, no prohibido — y «no existe» es exactamente la conclusión equivocada cuando
 * la migración sí se aplicó.
 *
 * ⭐ Y no es cosmético: sin esto nadie puede verificar desde fuera del pod lo que el puente
 * escribe, que es justo lo que `[CP.8.10]` necesita para dejar de estar `NO MEDIDO`.
 *
 * ── Por qué una migración nueva y no editar la anterior ─────────────────────────────────────
 * La anterior **ya está aplicada** (batch 856): editarla no la vuelve a correr, así que el
 * arreglo no llegaría a prod — y encima dejaría el archivo diciendo algo que esa corrida no
 * hizo. Regla del repo: una migración aplicada no se toca.
 *
 * Aditiva y de sólo lectura: `USAGE` en el schema + `SELECT` en las tablas + el default para las
 * que vengan después. No toca datos, no toca RLS (que sigue forzado: `dev_ro` ve lo que la
 * política le deje ver, igual que en los demás schemas).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  // Idempotente por naturaleza: `GRANT` sobre algo ya otorgado es un no-op.
  // ⚠️ `DO $$` con `has_schema_privilege` para no fallar si el rol no existe en un entorno
  // local — ahí `dev_ro` puede no estar creado y la migración no debe romper por eso.
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT USAGE ON SCHEMA contpaqi TO dev_ro;
        GRANT SELECT ON ALL TABLES IN SCHEMA contpaqi TO dev_ro;
        ALTER DEFAULT PRIVILEGES IN SCHEMA contpaqi GRANT SELECT ON TABLES TO dev_ro;
      END IF;
    END $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        ALTER DEFAULT PRIVILEGES IN SCHEMA contpaqi REVOKE SELECT ON TABLES FROM dev_ro;
        REVOKE SELECT ON ALL TABLES IN SCHEMA contpaqi FROM dev_ro;
        REVOKE USAGE ON SCHEMA contpaqi FROM dev_ro;
      END IF;
    END $$;
  `);
};
