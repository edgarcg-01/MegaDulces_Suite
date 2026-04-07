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
        // Tu Guard busca la llave exacta del endpoint y verifica que sea === true
        users: true,
        captures: true,
        daily_captures: true,
        catalogs: true,
        reports: true,        // <--- Esto activará /api/reports/summary
        summary: true,        // <--- Por si el decorator usa la ruta
        stores: true,
        visits: true,
        exhibitions: true,
        planograms: true,
        scoring: true
      }),
    })
    .onConflict("role_name")
    .merge();

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