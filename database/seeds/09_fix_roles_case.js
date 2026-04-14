/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Verificar si existen roles en catalogs con mayúsculas
  const catalogRoles = await knex('catalogs').where({ catalog_id: 'roles' }).select('id', 'value');
  console.log('[fix_roles_case] Roles en catalogs:', catalogRoles);

  const rolePermissions = await knex('role_permissions').select('role_name');
  console.log('[fix_roles_case] Roles en role_permissions:', rolePermissions);

  // Convertir roles en catalogs a minúsculas para que coincidan con role_permissions
  for (const role of catalogRoles) {
    if (role.value !== role.value.toLowerCase()) {
      console.log(`[fix_roles_case] Convirtiendo "${role.value}" a "${role.value.toLowerCase()}"`);
      await knex('catalogs')
        .where({ id: role.id })
        .update({ value: role.value.toLowerCase() });
    }
  }

  console.log('[fix_roles_case] Corrección de mayúsculas/minúsculas completada');
};
