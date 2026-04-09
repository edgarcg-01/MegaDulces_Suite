/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.seed = async function(knex) {
  // Disable foreign key checks or use TRUNCATE CASCADE
  // For PostgreSQL, TRUNCATE with CASCADE is the most reliable way
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
};
