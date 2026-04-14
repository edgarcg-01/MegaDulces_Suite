/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  console.log('[fix_roles_case_production] Iniciando corrección de mayúsculas/minúsculas en roles...');
  
  // Paso 1: Obtener roles válidos de role_permissions
  const validRoles = await knex('role_permissions').select('role_name');
  const validRoleNames = new Set(validRoles.map(r => r.role_name.toLowerCase()));
  console.log('[fix_roles_case_production] Roles válidos en role_permissions:', Array.from(validRoleNames));
  
  // Paso 2: Corregir roles en catalogs (catalog_id='roles')
  const catalogRoles = await knex('catalogs').where({ catalog_id: 'roles' }).select('id', 'value');
  console.log('[fix_roles_case_production] Roles en catalogs:', catalogRoles);
  
  let catalogFixedCount = 0;
  for (const role of catalogRoles) {
    const lowerRole = role.value.toLowerCase();
    
    // Si el rol tiene mayúsculas y existe en minúsculas en role_permissions
    if (role.value !== lowerRole && validRoleNames.has(lowerRole)) {
      console.log(`[fix_roles_case_production] Corrigiendo en catalogs: "${role.value}" -> "${lowerRole}"`);
      await knex('catalogs')
        .where({ id: role.id })
        .update({ value: lowerRole });
      catalogFixedCount++;
    }
    
    // Si el rol no existe en role_permissions, advertir
    if (!validRoleNames.has(lowerRole)) {
      console.log(`[fix_roles_case_production] ADVERTENCIA: Role en catalogs no existe en role_permissions: "${role.value}"`);
    }
  }
  
  // Paso 3: Corregir usuarios con role_name incorrecto
  const users = await knex('users').select('id', 'username', 'role_name');
  console.log('[fix_roles_case_production] Usuarios encontrados:', users.length);
  
  let userFixedCount = 0;
  for (const user of users) {
    const lowerRole = user.role_name.toLowerCase();
    
    // Si el rol tiene mayúsculas y existe en minúsculas en role_permissions
    if (user.role_name !== lowerRole && validRoleNames.has(lowerRole)) {
      console.log(`[fix_roles_case_production] Corrigiendo usuario ${user.username}: "${user.role_name}" -> "${lowerRole}"`);
      await knex('users')
        .where({ id: user.id })
        .update({ role_name: lowerRole });
      userFixedCount++;
    }
    
    // Si el rol no existe en role_permissions, advertir
    if (!validRoleNames.has(lowerRole)) {
      console.log(`[fix_roles_case_production] ADVERTENCIA: Usuario ${user.username} tiene rol inválido: "${user.role_name}"`);
    }
  }
  
  console.log(`[fix_roles_case_production] Corregidos ${catalogFixedCount} roles en catalogs`);
  console.log(`[fix_roles_case_production] Corregidos ${userFixedCount} usuarios`);
  console.log('[fix_roles_case_production] Migración completada');
};

exports.down = async function(knex) {
  console.log('[fix_roles_case_production] Rollback no soportado - esta migración es corrección de datos');
};
