/**
 * Seed: usuario superoot para Mega Dulces.
 *
 * Crea el usuario admin con:
 *   - tenant_id Mega Dulces
 *   - rol superadmin (debe existir por seed 02)
 *   - password hash bcrypt del password default (cambiar después en /admin/users)
 *
 * Idempotente: onConflict ignore.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function (knex) {
  const bcrypt = require('bcryptjs');
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';
  const SUPEROOT_USER_ID = '00000000-0000-0000-0000-00000000d0aa'; // UUID estable

  const DEFAULT_PASSWORD = process.env.SUPEROOT_INITIAL_PASSWORD || 'superoot';
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES_TENANT_ID}'`);

    await trx('users')
      .insert({
        id: SUPEROOT_USER_ID,
        tenant_id: MEGA_DULCES_TENANT_ID,
        username: 'superoot',
        password_hash: passwordHash,
        nombre: 'Super Root',
        role_name: 'superadmin',
        activo: true,
        meta_puntos: 5000,
      })
      .onConflict(['tenant_id', 'username'])
      .ignore();

    console.log(`[03_mega_dulces_superoot_user] Usuario 'superoot' (${SUPEROOT_USER_ID}) seeded con password '${DEFAULT_PASSWORD}'. CAMBIAR EN PROD.`);
  });
};
