const bcrypt = require('bcryptjs'); // Asegúrate de usar el que instalaste

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // 1. LIMPIEZA EN ORDEN (Vital para evitar el error de Foreign Key)
  // Primero borramos lo que DEPENDE de los roles (los usuarios)
  await knex("users").del();
  // Ahora sí podemos borrar los roles
  await knex("role_permissions").del();

  console.log('🧹 Database cleaned...');

  // 2. INSERTAR ROL SUPERADMIN
  await knex("role_permissions").insert({
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
  });

  // 3. GENERAR HASHES
  const adminHash = await bcrypt.hash("admin1", 10);
  const superootHash = await bcrypt.hash("superoot", 10);

  // 4. INSERTAR USUARIOS
  await knex("users").insert([
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
  ]);

  console.log(' Admin Users and Roles seed completed successfully.');
};