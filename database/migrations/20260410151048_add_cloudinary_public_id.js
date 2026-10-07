/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  await knex.schema.alterTable("exhibition_photos", (table) => {
    table.string("photo_public_id", 255);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  await knex.schema.alterTable("exhibition_photos", (table) => {
    table.dropColumn("photo_public_id");
  });
};
