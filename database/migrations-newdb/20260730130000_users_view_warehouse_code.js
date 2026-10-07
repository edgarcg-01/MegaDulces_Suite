/**
 * SM.9 — Expone `warehouse_code` en la vista passthrough `public.users`.
 *
 * La migración 20260702200000 agregó `warehouse_code` a la TABLA real
 * `identity.users`, pero la vista `public.users` (lista de columnas explícita)
 * nunca se recreó → no exponía la columna. Efecto: `auth-mt.service` lee el user
 * VÍA la vista, así que `user.warehouse_code` salía siempre `undefined` y el
 * scoping de sucursal por login estaba MUERTO para todo el proyecto Tienda
 * (monitor live, arqueo). Este fix lo revive: al recrear la vista, el login vuelve
 * a cargar la sucursal en el JWT. Patrón conocido: agregar columna a tabla bajo
 * vista passthrough exige recrear la vista (ver feedback_fieldops_passthrough_views).
 *
 * CREATE OR REPLACE VIEW agrega columnas SOLO al final → seguro.
 * NOTA: la API cachea `hasColumn` con TTL; el login lee la vista directo (no cache),
 * pero los usuarios afectados deben RE-LOGUEAR para que el JWT tome el warehouse_code.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.raw(
    `SELECT 1 FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'users'
        AND a.attname = 'warehouse_code' AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  if (has.rows.length) return; // ya expuesta

  await knex.raw(`
    CREATE OR REPLACE VIEW public.users AS
    SELECT
      id, tenant_id, username, password_hash, nombre, zona_id, role_name,
      supervisor_id, activo, meta_puntos, created_at, created_by, updated_at,
      updated_by, deleted_at, deleted_by, customer_id, last_login_at,
      last_login_ip, last_login_user_agent, warehouse_code
    FROM identity.users
  `);
};

exports.down = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW public.users AS
    SELECT
      id, tenant_id, username, password_hash, nombre, zona_id, role_name,
      supervisor_id, activo, meta_puntos, created_at, created_by, updated_at,
      updated_by, deleted_at, deleted_by, customer_id, last_login_at,
      last_login_ip, last_login_user_agent
    FROM identity.users
  `);
};
