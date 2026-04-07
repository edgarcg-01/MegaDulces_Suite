/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Borra los roles existentes para evitar duplicados
  await knex('role_permissions').del();
  
  // Inserta los roles base
  await knex('role_permissions').insert([
    { role_name: 'superadmin' },
    { role_name: 'ejecutivo' },
    { role_name: 'reportes' }
  ]);
}