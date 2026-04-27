/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Hash pre-calculado de la contraseña admin123 (bcrypt, salt rounds: 10)
  const passwordHash = '$2b$10$CrQ/d/rDn1uUL4cCcaT90.0uYucBusVYFH12/544FUNmDNT2naWiC';
  
  // Asegurar que el rol 'chofer' existe
  const choferRoleExists = await knex('role_permissions').where({ role_name: 'chofer' }).first();
  if (!choferRoleExists) {
    await knex('role_permissions').insert({
      id: knex.raw('gen_random_uuid()'),
      role_name: 'chofer',
      permissions: JSON.stringify({
        'driver.view': true,
        'driver.checklist': true,
        'driver.photo': true
      })
    });
    console.log('[02_create_drivers_users] Created chofer role.');
  }
  
  // Buscar colaboradores con role 'chofer' que no tengan user_id
  const drivers = await knex('logistica_colaboradores')
    .whereRaw("roles::text LIKE ?", ['%chofer%'])
    .whereNull('user_id')
    .select('id', 'nombre');
  
  if (drivers.length === 0) {
    console.log('[02_create_drivers_users] No drivers without user found, skipping seed.');
    return;
  }
  
  const usersToInsert = [];
  
  for (const driver of drivers) {
    // Generar username: primer_nombre_primer_apellido (en minúsculas)
    const nombreParts = driver.nombre.trim().split(/\s+/);
    const primerNombre = nombreParts[0]?.toLowerCase() || '';
    const primerApellido = nombreParts[1]?.toLowerCase() || '';
    const username = `${primerNombre}_${primerApellido}`.replace(/[^a-z0-9_]/g, '');
    
    // Verificar si el username ya existe
    const existingUser = await knex('users').where({ username }).first();
    if (existingUser) {
      console.log(`[02_create_drivers_users] Username ${username} already exists for driver ${driver.nombre}, skipping.`);
      continue;
    }
    
    usersToInsert.push({
      id: knex.raw('gen_random_uuid()'),
      username,
      password_hash: passwordHash,
      nombre: driver.nombre,
      role_name: 'chofer',
      activo: true,
      created_at: knex.fn.now()
    });
  }
  
  if (usersToInsert.length === 0) {
    console.log('[02_create_drivers_users] No new users to create.');
    return;
  }
  
  // Insertar usuarios y obtener los IDs generados
  const insertedUsers = await knex('users').insert(usersToInsert).returning('*');
  console.log(`[02_create_drivers_users] Inserted ${insertedUsers.length} driver users.`);
  
  // Actualizar logistica_colaboradores con los user_id usando los IDs reales
  for (const user of insertedUsers) {
    const driver = drivers.find(d => d.nombre === user.nombre);
    if (driver) {
      await knex('logistica_colaboradores')
        .where({ id: driver.id })
        .update({ user_id: user.id });
    }
  }
  
  console.log(`[02_create_drivers_users] Updated ${insertedUsers.length} collaborators with user_id.`);
};
