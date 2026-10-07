/**
 * Arqueo ciego para cajeras (proyecto Tienda, /tienda/arqueo) — permisos dedicados
 * STORE_ARQUEO_CAPTURAR / STORE_ARQUEO_VER.
 *
 * Mueve el arqueo ciego a la superficie Tienda para que las CAJERAS lo capturen sin
 * darles el motor de reconciliación del supervisor (RECONCILIATION_*). La captura y el
 * historial siguen viviendo también en /almacen/cuadre para el supervisor (misma tabla
 * `reconciliation.blind_counts`).
 *
 * Reparto de permisos:
 *   - OPERADORES (área `sucursal` + roles de tienda legacy + admin): CAPTURAR + VER.
 *   - AUDITORÍA (`prevencion_auditoria`): solo VER (no opera lo que audita).
 *
 * Aplica DESPUÉS de `..._area_role_presets_seed` (los roles de área ya existen).
 * Idempotente (merge `||` guardado por `@>`; match case-insensitive por role_name).
 * Los permisos viajan en el JWT → los usuarios afectados deben RE-LOGUEAR.
 *
 * @param { import("knex").Knex } knex
 */
const OPERATOR_ROLES = [
  'superadmin', 'admin', 'sucursal',
  'encargado_sucursal', 'jefe_de_tienda', 'auxiliar_sucursal', 'supervisora',
  'auxiliar_de_tienda',
];
const AUDIT_ROLES = ['prevencion_auditoria'];

exports.up = async function (knex) {
  const operatorPatch = JSON.stringify({ STORE_ARQUEO_CAPTURAR: true, STORE_ARQUEO_VER: true });
  const auditPatch = JSON.stringify({ STORE_ARQUEO_VER: true });

  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE lower(role_name) = ANY(:roles)
        AND NOT (permissions @> :patch::jsonb)`,
    { patch: operatorPatch, roles: OPERATOR_ROLES.map((r) => r.toLowerCase()) },
  );
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE lower(role_name) = ANY(:roles)
        AND NOT (permissions @> :patch::jsonb)`,
    { patch: auditPatch, roles: AUDIT_ROLES.map((r) => r.toLowerCase()) },
  );
};

exports.down = async function (knex) {
  const off = JSON.stringify({ STORE_ARQUEO_CAPTURAR: false, STORE_ARQUEO_VER: false });
  await knex.raw(
    `UPDATE role_permissions SET permissions = permissions || :off::jsonb
      WHERE lower(role_name) = ANY(:roles)`,
    { off, roles: [...OPERATOR_ROLES, ...AUDIT_ROLES].map((r) => r.toLowerCase()) },
  );
};
