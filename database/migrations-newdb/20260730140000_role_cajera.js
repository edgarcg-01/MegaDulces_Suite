/**
 * SM.9 — Rol mínimo `cajera` (proyecto Tienda).
 *
 * Rol dedicado de menor privilegio para las cajeras que capturan el arqueo ciego
 * en /tienda/arqueo: SOLO `STORE_ARQUEO_CAPTURAR` + `STORE_ARQUEO_VER`. No hereda
 * la superficie ancha de `sucursal` (25 permisos, incl. RECONCILIATION_GESTIONAR y
 * ajustes de inventario) — una cajera no debe ver ni operar nada más.
 *
 * Idempotente: inserta el rol solo para tenants activos que aún no lo tienen.
 * Los permisos viajan en el JWT → las cajeras deben (re)loguear para tomarlos.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    INSERT INTO identity.role_permissions (id, tenant_id, role_name, permissions, created_at, updated_at)
    SELECT gen_random_uuid(), t.id, 'cajera',
           '{"STORE_ARQUEO_CAPTURAR":true,"STORE_ARQUEO_VER":true}'::jsonb, now(), now()
      FROM identity.tenants t
     WHERE t.activo = true
       AND NOT EXISTS (
         SELECT 1 FROM identity.role_permissions rp
          WHERE rp.tenant_id = t.id AND lower(rp.role_name) = 'cajera'
       )
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DELETE FROM identity.role_permissions WHERE lower(role_name) = 'cajera'`);
};
