const bcrypt = require('bcryptjs');

exports.seed = async function(knex) {
  // 1. Limpieza total de usuarios
  await knex("users").del();

  const passwordDefault = bcrypt.hashSync("vendedor123", 10);
  const passwordSuper = bcrypt.hashSync("superoot", 10);

  // 2. Insertar Super Usuario
  await knex("users").insert({
    username: "superoot",
    password_hash: passwordSuper,
    role_name: "superadmin",
    zona: "NACIONAL",
    activo: true
  });

  // 3. Insertar Supervisores y obtener sus IDs
  const supervisors = [
    { username: "angel_vazquez", zona: "LA PIEDAD" },
    { username: "francisco_martinez", zona: "ZAMORA" },
    { username: "jose_herrera", zona: "MORELIA" }
  ];

  const supervisorMap = {};

  for (const sup of supervisors) {
    const [inserted] = await knex("users").insert({
      username: sup.username,
      password_hash: passwordDefault,
      role_name: "supervisor_v",
      zona: sup.zona,
      activo: true
    }).returning("id");
    
    // El formato del ID puede variar segun el DB (objeto o valor directo)
    supervisorMap[sup.zona] = typeof inserted === 'object' ? inserted.id : inserted;
  }

  // 4. Insertar Colaboradores asignados a sus supervisores
  const colaboradores = [
    // LA PIEDAD
    { username: "joaquin_hurtado", zona: "LA PIEDAD" },
    { username: "victorino_urbano", zona: "LA PIEDAD" },
    { username: "mariano_martinez", zona: "LA PIEDAD" },
    { username: "victor_garcia", zona: "LA PIEDAD" },
    { username: "victor_mata", zona: "LA PIEDAD" },
    { username: "jose_garcia", zona: "LA PIEDAD" },
    { username: "maria_valadez", zona: "LA PIEDAD" },
    { username: "maria_rocha", zona: "LA PIEDAD" },
    
    // ZAMORA
    { username: "victor_zalapa", zona: "ZAMORA" },
    { username: "daniel_rojano", zona: "ZAMORA" },
    { username: "jose_munoz", zona: "ZAMORA" },
    { username: "jose_zavala", zona: "ZAMORA" },
    
    // MORELIA
    { username: "cesar_plascencia", zona: "MORELIA" },
    { username: "guillermo_hernandez", zona: "MORELIA" },
    { username: "enrique_herrera", zona: "MORELIA" },
    { username: "joseph_guerrero", zona: "MORELIA" },
    { username: "eduardo_miranda", zona: "MORELIA" }
  ];

  for (const col of colaboradores) {
    await knex("users").insert({
      username: col.username,
      password_hash: passwordDefault,
      role_name: "colaborador",
      zona: col.zona,
      supervisor_id: supervisorMap[col.zona],
      activo: true
    });
  }
  
  console.log('Migración de usuarios completada: 21 usuarios creados.');
};
