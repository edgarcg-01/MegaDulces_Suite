/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Add LA PIEDAD VECINAL zone
  await knex('zones').insert([
    {
      id: knex.raw('gen_random_uuid()'),
      name: 'LA PIEDAD VECINAL',
      orden: 6
    }
  ]).onConflict('name').ignore(); // Ignore if already exists
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex('zones').where({ name: 'LA PIEDAD VECINAL' }).del();
};
