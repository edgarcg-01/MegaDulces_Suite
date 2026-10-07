/**
 * Etiquetera (proyecto Tienda) — permiso dedicado STORE_LABELS_VER.
 *
 * La etiquetera dejó de usar STORE_LIVE_VER y ahora usa STORE_LABELS_VER (separar
 * "ver monitor en vivo" de "imprimir etiquetas"). Esta migración:
 *   1. Otorga STORE_LABELS_VER a los roles que HOY imprimen etiquetas (tenían
 *      STORE_LIVE_VER) para que NO pierdan el acceso.
 *   2. Crea el rol acotado `etiquetas_tienda` = SOLO STORE_LABELS_VER (ej. rodrigo_ortiz).
 *
 * Nombre `grant_store_labels_perm` a propósito: ordena entre las migraciones de
 * etiquetas ya aplicadas (`..._label_*`) y `..._ra_purchasing_flow` pendiente, para
 * aplicarse SOLA con `migrate:up` en Railway sin arrastrar las migraciones de Compras/RA.
 *
 * Idempotente (merge `||` guardado por `@>`; UPSERT por (tenant_id, role_name)).
 * Los permisos viajan en el JWT → los usuarios afectados deben RE-LOGUEAR.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const STORE_ROLES = [
  'superadmin', 'admin', 'supervisor', 'gerente_de_zona',
  'jefe_de_tienda', 'auxiliar_de_tienda', 'encargado_sucursal', 'Auxiliar_sucursal',
];

exports.up = async function (knex) {
  const patch = JSON.stringify({ STORE_LABELS_VER: true });
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND NOT (permissions @> :patch::jsonb)`,
    { patch, roles: STORE_ROLES },
  );
  await knex.raw(
    `INSERT INTO identity.role_permissions (id, tenant_id, role_name, permissions)
     VALUES (gen_random_uuid(), :t, 'etiquetas_tienda', :perms::jsonb)
     ON CONFLICT (tenant_id, role_name)
       DO UPDATE SET permissions = EXCLUDED.permissions, updated_at = now()`,
    { t: M, perms: JSON.stringify({ STORE_LABELS_VER: true }) },
  );
};

exports.down = async function (knex) {
  const off = JSON.stringify({ STORE_LABELS_VER: false });
  await knex.raw(
    `UPDATE role_permissions SET permissions = permissions || :off::jsonb WHERE role_name = ANY(:roles)`,
    { off, roles: STORE_ROLES },
  );
  // El rol `etiquetas_tienda` NO se borra en down (puede tener usuarios asignados).
};
