/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  console.log('[fix_supervisor_id_production] Restaurando supervisor_id en producción...');
  
  // Mapeo de supervisores basado en el seed original 01_users.js (UUIDs completos)
  const supervisorMapping = {
    'LA PIEDAD': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37', // angel_vazquez
    'ZAMORA': 'f5ca24b4-4c08-473e-8991-c8a5377a26ed',    // francisco_martinez
    'MORELIA': '504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb'   // jose_herrera
  };
  
  // Mapeo específico de usuario -> supervisor (basado en datos de producción proporcionados)
  const userToSupervisorMapping = {
    'maria_rocha': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37',
    'maria_valadez': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37',
    'victor_mata': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37',
    'victor_garcia': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37',
    'mariano_martinez': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37',
    'victorino_urbano': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37',
    'joaquin_hurtado': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37',
    'jose_garcia': '7dc8ef21-8e65-4ffd-a5db-5a31a82b9b37',
    'victor_zalapa': 'f5ca24b4-4c08-473e-8991-c8a5377a26ed',
    'daniel_rojano': 'f5ca24b4-4c08-473e-8991-c8a5377a26ed',
    'jose_munoz': 'f5ca24b4-4c08-473e-8991-c8a5377a26ed',
    'jose_zavala': 'f5ca24b4-4c08-473e-8991-c8a5377a26ed',
    'eduardo_miranda': '504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb',
    'joseph_guerrero': '504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb',
    'enrique_herrera': '504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb',
    'guillermo_hernandez': '504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb',
    'cesar_plascencia': '504b1d53-a6ee-4eaf-a0ef-15b4ae9a2deb'
  };
  
  // Paso 1: Identificar todos los usuarios colaboradores (incluso si ya tienen supervisor_id)
  // Esto asegura que se reasignen los supervisores correctos en producción
  const colaboradores = await knex('users')
    .where('role_name', 'colaborador')
    .select('id', 'username', 'zona', 'supervisor_id');
  
  console.log(`[fix_supervisor_id_production] Colaboradores encontrados: ${colaboradores.length}`);
  
  let fixedCount = 0;
  let nullCount = 0;
  
  // Paso 2: Asignar supervisor basado en el mapeo específico de usuario
  for (const user of colaboradores) {
    let supervisorId = userToSupervisorMapping[user.username];
    
    // Si no hay mapeo específico, usar el mapeo por zona
    if (!supervisorId && user.zona && supervisorMapping[user.zona]) {
      supervisorId = supervisorMapping[user.zona];
    }
    
    // Si no hay zona o mapeo por zona, asignar al supervisor de LA PIEDAD por defecto
    if (!supervisorId) {
      supervisorId = supervisorMapping['LA PIEDAD'];
      console.log(`[fix_supervisor_id_production] WARNING: Asignando supervisor por defecto a ${user.username} (sin zona o mapeo)`);
    }
    
    // Actualizar si el supervisor es diferente o es null
    if (supervisorId && user.supervisor_id !== supervisorId) {
      console.log(`[fix_supervisor_id_production] Actualizando supervisor para ${user.username}: ${user.supervisor_id || 'NULL'} -> ${supervisorId}`);
      await knex('users')
        .where({ id: user.id })
        .update({ supervisor_id: supervisorId });
      fixedCount++;
      
      if (!user.supervisor_id) {
        nullCount++;
      }
    }
  }
  
  console.log(`[fix_supervisor_id_production] Resumen:`);
  console.log(`  - Colaboradores encontrados: ${colaboradores.length}`);
  console.log(`  - Usuarios actualizados: ${fixedCount}`);
  console.log(`  - Usuarios que tenían NULL: ${nullCount}`);
  console.log('[fix_supervisor_id_production] Migración completada');
};

exports.down = async function(knex) {
  console.log('[fix_supervisor_id_production] Rollback no soportado - esta migración es corrección de datos');
};
