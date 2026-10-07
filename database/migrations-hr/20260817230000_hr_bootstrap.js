/**
 * Fase CH — bootstrap de la base dedicada de asistencia (`hr` en 192.168.0.245).
 *
 * Esta base nace vacía, así que primero hay que plantar lo que en
 * `postgres_platform` ya venía dado por las migraciones de la Fase A.0mt:
 *   - el schema `hr`
 *   - `public.current_tenant_id()`, que es de lo que cuelgan las policies RLS
 *   - los grants al rol `app_runtime` (el rol es del cluster, no de la base,
 *     así que ya existe; lo que falta son los privilegios DENTRO de esta base)
 *
 * Se mantiene `tenant_id` + RLS aunque la base sea de un solo inquilino: es
 * la convención del proyecto y deja la puerta abierta a consolidar de vuelta en
 * `postgres_platform` sin reescribir el schema.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS hr`);

  // Misma definición que en postgres_platform: lee el tenant del contexto de
  // sesión que setea TenantKnexService.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS uuid
      LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
      $$`);

  // El rol existe a nivel cluster; acá se le abre el paso a ESTA base.
  const { rows } = await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`);
  if (rows.length) {
    // GRANT no acepta subquery para el nombre de la base, y con connectionString
    // `knex.client.database()` viene undefined → se resuelve en el server.
    await knex.raw(`
      DO $$ BEGIN
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_runtime', current_database());
      END $$`);
    await knex.raw(`GRANT USAGE ON SCHEMA hr TO app_runtime`);
    await knex.raw(`GRANT USAGE ON SCHEMA public TO app_runtime`);
    await knex.raw(`GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS public.current_tenant_id()`);
  await knex.raw(`DROP SCHEMA IF EXISTS hr CASCADE`);
};
