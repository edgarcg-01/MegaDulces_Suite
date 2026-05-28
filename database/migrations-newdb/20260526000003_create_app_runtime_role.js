/**
 * Migración: crea el rol `app_runtime` que la app debe usar en runtime.
 *
 * ¿Por qué? Postgres tiene una sutileza importante con RLS:
 *   - Los SUPERUSERS y los roles con BYPASSRLS bypasean RLS SIEMPRE.
 *   - Incluso con `FORCE ROW LEVEL SECURITY`, los superusers siguen viendo todo.
 *
 * Si la app se conecta como `postgres` (default en Railway/local), RLS NO
 * filtra → cualquier bug del API expone data cross-tenant.
 *
 * Solución: crear un rol no-superuser y conectar la app con ese rol.
 *
 * - app_runtime tiene CRUD en tablas pero NO es superuser ni BYPASSRLS.
 * - Las migraciones siguen corriendo como `postgres` (necesario para
 *   CREATE TABLE / ALTER, etc.).
 * - La app en runtime se conecta como `app_runtime`.
 *
 * Password: tomado de env var `APP_RUNTIME_PASSWORD` con fallback `app_runtime`
 * solo para desarrollo local. En producción siempre setear la env var.
 *
 * Idempotente: si el rol ya existe, no falla.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const password = process.env.APP_RUNTIME_PASSWORD || 'app_runtime';

  // Crear rol si no existe (con LOGIN)
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        CREATE ROLE app_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        RAISE NOTICE 'Created role app_runtime';
      ELSE
        RAISE NOTICE 'Role app_runtime already exists, skipping creation';
      END IF;
    END $$;
  `);

  // Asegurar atributos correctos (por si el rol ya existía con configuración mala)
  await knex.raw(`ALTER ROLE app_runtime NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);

  // Asegurar password (no daña si no cambia)
  await knex.raw(`ALTER ROLE app_runtime WITH PASSWORD '${password}'`);

  // ── GRANTS ───────────────────────────────────────────────────────────────
  // USAGE en schema public para ver/usar tablas
  await knex.raw(`GRANT USAGE ON SCHEMA public TO app_runtime`);

  // CRUD en TODAS las tablas existentes
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime`);

  // USAGE en TODAS las secuencias existentes (para defaults gen_random_uuid no aplica
  // pero por si algún día agregamos SERIAL/IDENTITY)
  await knex.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime`);

  // EXECUTE en TODAS las funciones (incluyendo current_tenant_id())
  await knex.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_runtime`);

  // ── DEFAULT PRIVILEGES (para tablas FUTURAS) ─────────────────────────────
  // Sin esto, cada vez que crea una tabla nueva, hay que GRANT manual.
  // ALTER DEFAULT PRIVILEGES aplica a tablas creadas DESPUÉS por el role que
  // ejecuta (en migraciones, postgres).
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime
  `);
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO app_runtime
  `);
  await knex.raw(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO app_runtime
  `);

  console.log(`[create_app_runtime_role] Rol app_runtime configurado con password "${password}". Cambiar en prod via ALTER ROLE.`);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  // Revocar privilegios primero, después dropear el rol
  await knex.raw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime`).catch(() => {});
  await knex.raw(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_runtime`).catch(() => {});
  await knex.raw(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM app_runtime`).catch(() => {});
  await knex.raw(`REVOKE USAGE ON SCHEMA public FROM app_runtime`).catch(() => {});
  await knex.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM app_runtime`).catch(() => {});
  await knex.raw(`DROP ROLE IF EXISTS app_runtime`).catch(() => {});
};
