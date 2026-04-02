const bcrypt = require('bcryptjs');

exports.seed = async function(knex) {
  // 1. Limpieza de usuarios
  await knex("users").del();

  // Generar hash para la contraseña 'admin123'
  const passwordHash = bcrypt.hashSync("admin123", 10);

  const users = [
    {
      username: "superoot",
      password_hash: passwordHash,
      role_name: "superadmin",
      zona: "Nacional",
      activo: true,
    },
    {
      username: "admin",
      password_hash: passwordHash,
      role_name: "admin",
      zona: "Zona Centro",
      activo: true,
    },
  ];

  for (const user of users) {
    await knex("users").insert({
      username: user.username,
      password_hash: user.password_hash,
      role_name: user.role_name,
      zona: user.zona,
      activo: user.activo,
    });
  }
};
