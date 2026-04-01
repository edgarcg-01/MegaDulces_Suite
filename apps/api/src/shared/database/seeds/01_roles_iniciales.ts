import type { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
  // Borra los roles existentes para evitar duplicados
  await knex('role_permissions').del();
  
  // Inserta los roles base
  await knex('role_permissions').insert([
    { role_name: 'superadmin' },
    { role_name: 'ejecutivo' },
    { role_name: 'reportes' }
  ]);
}