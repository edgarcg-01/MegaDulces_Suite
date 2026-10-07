/**
 * 000_cleanup.js
 *
 * SOLO se ejecuta en desarrollo local o cuando la BD está vacía.
 * En producción este seed es un NO-OP porque start.sh ya detecta si hay
 * datos antes de llamar a `knex seed:run`.
 *
 * Si alguna vez necesitas resetear producción a mano, ejecuta:
 *   NODE_ENV=production FORCE_SEED_CLEANUP=true npx knex seed:run --knexfile database/knexfile.js
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Guard: never wipe production data unless explicitly forced
  if (process.env.NODE_ENV === 'production' && process.env.FORCE_SEED_CLEANUP !== 'true') {
    console.log('[000_cleanup] Skipped — NODE_ENV=production. Set FORCE_SEED_CLEANUP=true to override.');
    return;
  }

  console.log('[000_cleanup] Truncating all tables...');
  await knex.raw('TRUNCATE TABLE "users" CASCADE');
  await knex.raw('TRUNCATE TABLE "role_permissions" CASCADE');
  await knex.raw('TRUNCATE TABLE "captures" CASCADE');
  await knex.raw('TRUNCATE TABLE "scoring_config" CASCADE');
  await knex.raw('TRUNCATE TABLE "stores" CASCADE');
  await knex.raw('TRUNCATE TABLE "visits" CASCADE');
  await knex.raw('TRUNCATE TABLE "exhibitions" CASCADE');
  await knex.raw('TRUNCATE TABLE "exhibition_photos" CASCADE');
  await knex.raw('TRUNCATE TABLE "catalogs" CASCADE');
  await knex.raw('TRUNCATE TABLE "daily_captures" CASCADE');
  await knex.raw('TRUNCATE TABLE "brands" CASCADE');
  await knex.raw('TRUNCATE TABLE "products" CASCADE');
  await knex.raw('TRUNCATE TABLE "daily_assignments" CASCADE');
  console.log('[000_cleanup] Done.');
};
