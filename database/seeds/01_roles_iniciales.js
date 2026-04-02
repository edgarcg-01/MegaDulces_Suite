exports.seed = async function(knex) {
  await knex("roles").del();
  await knex("roles").insert([
    { nombre: "superadmin", activo: true },
    { nombre: "admin", activo: true },
    { nombre: "supervisor", activo: true },
    { nombre: "auditor", activo: true },
  ]);
};