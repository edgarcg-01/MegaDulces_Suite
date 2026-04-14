/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  console.log('[sync_roles_production] Sincronizando roles entre catalogs y role_permissions...');
  
  // Paso 1: Obtener roles de ambas tablas
  const catalogRoles = await knex('catalogs').where({ catalog_id: 'roles' }).select('id', 'value');
  const rolePermissions = await knex('role_permissions').select('role_name', 'permissions', 'id');
  
  console.log('[sync_roles_production] Roles en catalogs:', catalogRoles.map(r => r.value));
  console.log('[sync_roles_production] Roles en role_permissions:', rolePermissions.map(r => r.role_name));
  
  const catalogRoleNames = new Set(catalogRoles.map(r => r.value.toLowerCase()));
  const permissionRoleNames = new Set(rolePermissions.map(r => r.role_name.toLowerCase()));
  
  // Paso 2: Para cada rol en catalogs, asegurar que exista en role_permissions
  for (const catalogRole of catalogRoles) {
    const lowerName = catalogRole.value.toLowerCase();
    
    if (!permissionRoleNames.has(lowerName)) {
      console.log(`[sync_roles_production] Rol "${catalogRole.value}" no existe en role_permissions, creándolo...`);
      
      // Crear rol en role_permissions con permisos vacíos o permisos de admin por defecto
      const defaultPermissions = JSON.stringify({
        VISITAS_VER: true,
        USUARIOS_VER: true,
        VISITAS_AUDITAR: false,
        ROLES_CONFIGURAR: false,
        REPORTES_EXPORTAR: false,
        VISITAS_REGISTRAR: true,
        CATALOGO_GESTIONAR: false,
        SCORING_CONFIG_VER: true,
        USUARIOS_GESTIONAR: false,
        USUARIOS_PASSWORDS: false,
        REPORTES_VER_EQUIPO: true,
        REPORTES_VER_GLOBAL: false,
        REPORTES_VER_PROPIO: true,
        PLANOGRAMAS_GESTIONAR: false,
        USUARIOS_ASIGNAR_RUTA: false,
        SCORING_CONFIG_GESTIONAR: false
      });
      
      await knex('role_permissions').insert({
        id: require('crypto').randomUUID(),
        role_name: lowerName,
        permissions: defaultPermissions
      });
      
      console.log(`[sync_roles_production] Rol "${lowerName}" creado en role_permissions`);
    }
  }
  
  // Paso 3: Actualizar usuarios con role_name que no existen en role_permissions
  const users = await knex('users').select('id', 'username', 'role_name');
  const updatedRolePermissions = await knex('role_permissions').select('role_name');
  const validRoleNames = new Set(updatedRolePermissions.map(r => r.role_name.toLowerCase()));
  
  let userFixedCount = 0;
  for (const user of users) {
    const lowerRole = user.role_name.toLowerCase();
    
    if (!validRoleNames.has(lowerRole)) {
      console.log(`[sync_roles_production] Usuario ${user.username} tiene rol inválido: "${user.role_name}"`);
      
      // Intentar encontrar un rol similar en role_permissions
      const similarRole = Array.from(validRoleNames).find(valid => 
        valid.includes(lowerRole.replace(/[_\s]/g, '')) ||
        lowerRole.includes(valid.replace(/[_\s]/g, ''))
      );
      
      if (similarRole) {
        console.log(`[sync_roles_production] Asignando rol similar: "${similarRole}"`);
        await knex('users').where({ id: user.id }).update({ role_name: similarRole });
        userFixedCount++;
      } else {
        console.log(`[sync_roles_production] No se encontró rol similar para "${user.role_name}", asignando 'colaborador' por defecto`);
        await knex('users').where({ id: user.id }).update({ role_name: 'colaborador' });
        userFixedCount++;
      }
    }
  }
  
  // Paso 4: Normalizar roles en catalogs a minúsculas para consistencia
  for (const catalogRole of catalogRoles) {
    const lowerName = catalogRole.value.toLowerCase();
    if (catalogRole.value !== lowerName) {
      console.log(`[sync_roles_production] Normalizando "${catalogRole.value}" -> "${lowerName}"`);
      await knex('catalogs').where({ id: catalogRole.id }).update({ value: lowerName });
    }
  }
  
  console.log(`[sync_roles_production] Corregidos ${userFixedCount} usuarios`);
  console.log('[sync_roles_production] Sincronización completada');
};

exports.down = async function(knex) {
  console.log('[sync_roles_production] Rollback no soportado - esta migración es corrección de datos');
};
