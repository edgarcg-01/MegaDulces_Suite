/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  console.log('[fix_supervisor_id_integrity] Verificando integridad de supervisor_id...');
  
  // Mapeo de supervisores basado en el seed original 01_users.js
  const supervisorMapping = {
    'LA PIEDAD': '7dc8ef21', // angel_vazquez
    'ZAMORA': 'f5ca24b4',    // francisco_martinez
    'MORELIA': '504b1d53'   // jose_herrera
  };
  
  // Mapeo específico de usuario -> supervisor para casos especiales
  const userToSupervisorMapping = {
    'joaquin_hurtado': '7dc8ef21',
    'victorino_urbano': '7dc8ef21',
    'mariano_martinez': '7dc8ef21',
    'victor_garcia': '7dc8ef21',
    'victor_mata': '7dc8ef21',
    'jose_garcia': '7dc8ef21',
    'maria_valadez': '7dc8ef21',
    'maria_rocha': '7dc8ef21',
    'victor_zalapa': 'f5ca24b4',
    'daniel_rojano': 'f5ca24b4',
    'jose_munoz': 'f5ca24b4',
    'jose_zavala': 'f5ca24b4',
    'cesar_plascencia': '504b1d53',
    'guillermo_hernandez': '504b1d53',
    'enrique_herrera': '504b1d53',
    'joseph_guerrero': '504b1d53',
    'eduardo_miranda': '504b1d53'
  };
  
  // Paso 1: Identificar usuarios colaboradores sin supervisor
  const usersWithoutSupervisor = await knex('users')
    .whereNull('supervisor_id')
    .where('role_name', 'colaborador')
    .select('id', 'username', 'zona');
  
  console.log(`[fix_supervisor_id_integrity] Usuarios colaboradores sin supervisor: ${usersWithoutSupervisor.length}`);
  
  if (usersWithoutSupervisor.length === 0) {
    console.log('[fix_supervisor_id_integrity] No se encontraron usuarios sin supervisor. Migración completada.');
    return;
  }
  
  let fixedCount = 0;
  
  // Paso 2: Asignar supervisor basado en el mapeo específico de usuario
  for (const user of usersWithoutSupervisor) {
    let supervisorId = userToSupervisorMapping[user.username];
    
    // Si no hay mapeo específico, usar el mapeo por zona
    if (!supervisorId && user.zona && supervisorMapping[user.zona]) {
      supervisorId = supervisorMapping[user.zona];
    }
    
    // Si no hay zona o mapeo por zona, asignar al supervisor de LA PIEDAD por defecto
    if (!supervisorId) {
      supervisorId = supervisorMapping['LA PIEDAD'];
      console.log(`[fix_supervisor_id_integrity] WARNING: Asignando supervisor por defecto a ${user.username} (sin zona o mapeo)`);
    }
    
    if (supervisorId) {
      console.log(`[fix_supervisor_id_integrity] Asignando supervisor ${supervisorId} a ${user.username} (zona: ${user.zona || 'N/A'})`);
      await knex('users')
        .where({ id: user.id })
        .update({ supervisor_id: supervisorId });
      fixedCount++;
    } else {
      console.log(`[fix_supervisor_id_integrity] ERROR: No se pudo asignar supervisor a ${user.username}`);
    }
  }
  
  console.log(`[fix_supervisor_id_integrity] Resumen:`);
  console.log(`  - Usuarios sin supervisor encontrados: ${usersWithoutSupervisor.length}`);
  console.log(`  - Usuarios corregidos: ${fixedCount}`);
  console.log('[fix_supervisor_id_integrity] Migración completada');
};

exports.down = async function(knex) {
  console.log('[fix_supervisor_id_integrity] Rollback no soportado - esta migración es corrección de datos');
};
