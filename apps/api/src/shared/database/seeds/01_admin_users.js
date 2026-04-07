const bcrypt = require('bcryptjs');

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // 1. INSERTAR/ACTUALIZAR ROL SUPERADMIN
  await knex("role_permissions")
    .insert({
      role_name: "superadmin",
      permissions: JSON.stringify({
        users: true,
        captures: true,
        daily_captures: true,
        catalogs: true,
        reports: true,
        summary: true, // Crucial para /api/reports/summary
        data: true,    // Crucial para /api/reports/data
        stores: true,
        visits: true,
        exhibitions: true,
        planograms: true,
        scoring: true
      }),
    })
    .onConflict("role_name")
    .merge();

  // 2. GENERAR HASHES
  const adminHash = await bcrypt.hash("admin1", 10);
  const superootHash = await bcrypt.hash("superoot", 10);

  // 3. UPSERT DE USUARIOS (Para evitar errores de duplicados)
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
    }
  ];

  for (const user of users) {
    await knex("users")
      .insert(user)
      .onConflict("username")
      .merge(); // Si ya existe, actualiza sus datos y permisos
  }

  console.log(' Admin Users and Roles seed completed successfully.');
};