/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  // 1. Create zones table
  await knex.schema.createTable('zones', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name', 100).notNullable().unique();
    table.integer('orden').defaultTo(0);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // 2. Migrate data from catalogs (catalog_id = 'zonas') to zones
  const existingZones = await knex('catalogs')
    .where({ catalog_id: 'zonas' })
    .select('value', 'orden');

  if (existingZones.length > 0) {
    const zonesToInsert = existingZones.map((z) => ({
      name: z.value,
      orden: z.orden,
    }));
    await knex('zones').insert(zonesToInsert);
  }

  // 3. Add zona_id to users and stores
  await knex.schema.alterTable('users', (table) => {
    table.uuid('zona_id').references('id').inTable('zones');
  });

  await knex.schema.alterTable('stores', (table) => {
    table.uuid('zona_id').references('id').inTable('zones');
  });

  // 4. Populate zona_id by matching string value
  await knex.raw(`
    UPDATE users 
    SET zona_id = zones.id 
    FROM zones 
    WHERE users.zona = zones.name
  `);

  await knex.raw(`
    UPDATE stores 
    SET zona_id = zones.id 
    FROM zones 
    WHERE stores.zona = zones.name
  `);

  // 5. Cleanup: Remove 'zonas' from catalogs to avoid confusion
  await knex('catalogs').where({ catalog_id: 'zonas' }).delete();
  
  // 6. We keep the 'zona' string columns for now as 'legacy' to avoid breaking code 
  // until we refactor the services in the next step.
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('stores', (table) => {
    table.dropColumn('zona_id');
  });
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('zona_id');
  });
  await knex.schema.dropTableIfExists('zones');
};
