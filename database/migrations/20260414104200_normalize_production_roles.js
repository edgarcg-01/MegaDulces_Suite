/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  console.log('[normalize_production_roles] Normalizando roles para producción...');
  
  const { randomUUID } = require('crypto');
  
  // Mapeo de nombres de roles de producción a nombres normalizados
  const roleMapping = {
    'superadmin': 'superadmin',
    'Superadmin': 'superadmin',
    'jefe marketing': 'jefe_marketing',
    'Jefe marketing': 'jefe_marketing',
    'Jefe Marketing': 'jefe_marketing',
    'supervisor de ventas': 'supervisor_ventas',
    'Supervisor de Ventas': 'supervisor_ventas',
    'Supervisor de ventas': 'supervisor_ventas',
    'colaborador': 'colaborador',
    'Colaborador': 'colaborador'
  };
  
  // Obtener roles actuales en catalogs
  const catalogRoles = await knex('catalogs').where({ catalog_id: 'roles' }).select('id', 'value');
  console.log('[normalize_production_roles] Roles actuales en catalogs:', catalogRoles.map(r => r.value));
  
  // Obtener roles actuales en role_permissions
  const rolePermissions = await knex('role_permissions').select('role_name');
  const existingRoleNames = new Set(rolePermissions.map(r => r.role_name.toLowerCase()));
  console.log('[normalize_production_roles] Roles existentes en role_permissions:', Array.from(existingRoleNames));
  
  let catalogFixedCount = 0;
  let permissionsCreatedCount = 0;
  
  // Procesar cada rol en catalogs
  for (const catalogRole of catalogRoles) {
    const originalValue = catalogRole.value;
    const normalizedValue = roleMapping[originalValue.toLowerCase()] || 
                             roleMapping[originalValue] || 
                             originalValue.toLowerCase().replace(/\s+/g, '_');
    
    console.log(`[normalize_production_roles] Procesando: "${originalValue}" -> "${normalizedValue}"`);
    
    // Si el valor es diferente, actualizar catalogs
    if (originalValue !== normalizedValue) {
      await knex('catalogs')
        .where({ id: catalogRole.id })
        .update({ value: normalizedValue });
      catalogFixedCount++;
      console.log(`[normalize_production_roles] Actualizado en catalogs: "${originalValue}" -> "${normalizedValue}"`);
    }
    
    // Si el rol normalizado no existe en role_permissions, crearlo
    if (!existingRoleNames.has(normalizedValue)) {
      console.log(`[normalize_production_roles] Creando rol "${normalizedValue}" en role_permissions`);
      
      // Permisos por defecto según el tipo de rol
      let permissions;
      if (normalizedValue === 'superadmin') {
        permissions = JSON.stringify({
          VISITAS_VER: true, USUARIOS_VER: true, VISITAS_AUDITAR: true,
          ROLES_CONFIGURAR: true, REPORTES_EXPORTAR: true, VISITAS_REGISTRAR: true,
          CATALOGO_GESTIONAR: true, SCORING_CONFIG_VER: true, USUARIOS_GESTIONAR: true,
          USUARIOS_PASSWORDS: true, REPORTES_VER_EQUIPO: true, REPORTES_VER_GLOBAL: true,
          REPORTES_VER_PROPIO: true, PLANOGRAMAS_GESTIONAR: true, USUARIOS_ASIGNAR_RUTA: true,
          SCORING_CONFIG_GESTIONAR: true
        });
      } else if (normalizedValue.includes('supervisor')) {
        permissions = JSON.stringify({
          VISITAS_VER: true, USUARIOS_VER: true, VISITAS_AUDITAR: true,
          ROLES_CONFIGURAR: false, REPORTES_EXPORTAR: true, VISITAS_REGISTRAR: true,
          CATALOGO_GESTIONAR: false, SCORING_CONFIG_VER: true, USUARIOS_GESTIONAR: false,
          USUARIOS_PASSWORDS: false, REPORTES_VER_EQUIPO: true, REPORTES_VER_GLOBAL: false,
          REPORTES_VER_PROPIO: true, PLANOGRAMAS_GESTIONAR: false, USUARIOS_ASIGNAR_RUTA: true,
          SCORING_CONFIG_GESTIONAR: false
        });
      } else {
        permissions = JSON.stringify({
          VISITAS_VER: true, USUARIOS_VER: false, VISITAS_AUDITAR: false,
          ROLES_CONFIGURAR: false, REPORTES_EXPORTAR: false, VISITAS_REGISTRAR: true,
          CATALOGO_GESTIONAR: false, SCORING_CONFIG_VER: true, USUARIOS_GESTIONAR: false,
          USUARIOS_PASSWORDS: false, REPORTES_VER_EQUIPO: false, REPORTES_VER_GLOBAL: false,
          REPORTES_VER_PROPIO: true, PLANOGRAMAS_GESTIONAR: false, USUARIOS_ASIGNAR_RUTA: false,
          SCORING_CONFIG_GESTIONAR: false
        });
      }
      
      await knex('role_permissions').insert({
        id: randomUUID(),
        role_name: normalizedValue,
        permissions: permissions
      });
      permissionsCreatedCount++;
      existingRoleNames.add(normalizedValue);
    }
  }
  
  // Actualizar usuarios con roles que no existen en role_permissions
  const users = await knex('users').select('id', 'username', 'role_name');
  let userFixedCount = 0;
  
  for (const user of users) {
    const originalRole = user.role_name;
    const normalizedRole = roleMapping[originalRole.toLowerCase()] || 
                           roleMapping[originalRole] || 
                           originalRole.toLowerCase().replace(/\s+/g, '_');
    
    if (originalRole !== normalizedRole && existingRoleNames.has(normalizedRole)) {
      console.log(`[normalize_production_roles] Actualizando usuario ${user.username}: "${originalRole}" -> "${normalizedRole}"`);
      await knex('users').where({ id: user.id }).update({ role_name: normalizedRole });
      userFixedCount++;
    }
    
    // Si el rol no existe después de normalizar, asignar colaborador por defecto
    if (!existingRoleNames.has(normalizedRole)) {
      console.log(`[normalize_production_roles] Usuario ${user.username} tiene rol inválido: "${originalRole}", asignando 'colaborador'`);
      await knex('users').where({ id: user.id }).update({ role_name: 'colaborador' });
      userFixedCount++;
    }
  }
  
  console.log(`[normalize_production_roles] Resumen:`);
  console.log(`  - Roles en catalogs actualizados: ${catalogFixedCount}`);
  console.log(`  - Roles en role_permissions creados: ${permissionsCreatedCount}`);
  console.log(`  - Usuarios actualizados: ${userFixedCount}`);
  console.log('[normalize_production_roles] Normalización completada');
};

exports.down = async function(knex) {
  console.log('[normalize_production_roles] Rollback no soportado - esta migración es corrección de datos');
};
