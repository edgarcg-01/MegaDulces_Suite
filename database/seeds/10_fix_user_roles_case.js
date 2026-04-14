/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  console.log('[fix_user_roles_case] Buscando usuarios con role_name en mayúsculas...');
  
  // Obtener todos los usuarios
  const users = await knex('users').select('id', 'username', 'role_name');
  console.log('[fix_user_roles_case] Usuarios encontrados:', users.length);
  
  // Obtener roles válidos de role_permissions
  const validRoles = await knex('role_permissions').select('role_name');
  const validRoleNames = new Set(validRoles.map(r => r.role_name));
  console.log('[fix_user_roles_case] Roles válidos:', Array.from(validRoleNames));
  
  let fixedCount = 0;
  
  for (const user of users) {
    const lowerRole = user.role_name.toLowerCase();
    
    // Si el rol tiene mayúsculas y existe en minúsculas en role_permissions
    if (user.role_name !== lowerRole && validRoleNames.has(lowerRole)) {
      console.log(`[fix_user_roles_case] Corrigiendo usuario ${user.username}: "${user.role_name}" -> "${lowerRole}"`);
      await knex('users')
        .where({ id: user.id })
        .update({ role_name: lowerRole });
      fixedCount++;
    }
    
    // Si el rol no existe en role_permissions
    if (!validRoleNames.has(user.role_name.toLowerCase())) {
      console.log(`[fix_user_roles_case] Usuario ${user.username} tiene rol inválido: "${user.role_name}"`);
    }
  }
  
  console.log(`[fix_user_roles_case] Corregidos ${fixedCount} usuarios`);
};
