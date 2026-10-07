/**
 * Backfill Fase I.0: otorga los permisos de inventario físico a los roles que
 * los definen en el seed. Sin esto, las keys quedan AUSENTES del JSONB en roles
 * sembrados antes de Fase I → nav oculto / 403 (incidente conocido del proyecto).
 *
 * Jerarquía:
 *   CONTAR      → superadmin, admin, supervisor, colaborador (contadores de piso)
 *   SUPERVISAR  → superadmin, admin, supervisor (analiza + resuelve discrepancias)
 *   RECONCILIAR → superadmin, admin (autoridad del ajuste de saldo = del dinero)
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO el operador `?` — knex no lo escapa).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const grants = [
    { key: 'COMMERCIAL_INVENTORY_CONTAR', roles: ['superadmin', 'admin', 'supervisor', 'colaborador'] },
    { key: 'COMMERCIAL_INVENTORY_SUPERVISAR', roles: ['superadmin', 'admin', 'supervisor'] },
    { key: 'COMMERCIAL_INVENTORY_RECONCILIAR', roles: ['superadmin', 'admin'] },
  ];

  for (const { key, roles } of grants) {
    const patch = JSON.stringify({ [key]: true });
    const result = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || :patch::jsonb
        WHERE role_name = ANY(:roles)
          AND permissions -> :key IS NULL`,
      { patch, roles, key },
    );
    console.log(`[backfill_inventory_count_perms] ${key} otorgado a ${result.rowCount ?? 0} rol(es).`);
  }
};

exports.down = async function () {
  console.log('[backfill_inventory_count_perms] down: no-op');
};
