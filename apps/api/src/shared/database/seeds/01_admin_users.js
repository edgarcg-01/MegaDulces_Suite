const bcrypt = require('bcrypt'); // O require('bcryptjs') según tu package.json

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // 1. Upsert del rol superadmin con todos los permisos
  await knex("role_permissions")
    .insert({
      role_name: "superadmin",
      permissions: JSON.stringify({
        users: ["create", "read", "update", "delete"],
        captures: ["create", "read", "update", "delete"],
        daily_captures: ["create", "read", "update", "delete"],
        catalogs: ["create", "read", "update", "delete"],
        reports: ["create", "read", "update", "delete"],
        stores: ["create", "read", "update", "delete"],
        visits: ["create", "read", "update", "delete"],
        exhibitions: ["create", "read", "update", "delete"],
        planograms: ["create", "read", "update", "delete"],
        scoring: ["create", "read", "update", "delete"],
      }),
    })
    .onConflict("role_name")
    .merge();

  // 2. Hash de contraseñas (10 salt rounds)
  const adminHash = await bcrypt.hash("admin1", 10);
  const superootHash = await bcrypt.hash("superoot", 10);

  // 3. Definición de usuarios admin
  const users = [
    {
      username: "admin",
      password_hash: adminHash,
      nombre: "Administrador General",
      zona: "Nacional",
      role_name: "superadmin",
      activo: true,
    },
    {
      username: "superoot",
      password_hash: superootHash,
      nombre: "Super Root",
      zona: "Nacional",
      role_name: "superadmin",
      activo: true,
    },
  ];

  // 4. Ejecutar Upserts individuales para usuarios
  for (const user of users) {
    await knex("users")
      .insert(user)
      .onConflict("username")
      .merge({
        password_hash: user.password_hash,
        nombre: user.nombre,
        zona: user.zona,
        role_name: user.role_name,
        activo: user.activo,
      });
  }
  
  console.log('Admin Users and Roles seed completed.');
};