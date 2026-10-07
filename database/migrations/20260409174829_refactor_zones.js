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

  // 2. Seed default zones directly (in case seeds haven't run yet)
  // These are the standard zones for the application
  // IMPORTANT: Use fixed UUIDs that match seeds/00a_zones.js
  const defaultZones = [
    { id: 'fb136f01-5efe-4c9f-b297-48f06574002c', name: 'LA PIEDAD', orden: 1 },
    { id: 'b3e5d1cf-bf7e-419f-9037-b02f070bd2bc', name: 'ZAMORA', orden: 2 },
    { id: '2107b482-7d3a-4c82-9377-c9f2427e699e', name: 'MORELIA', orden: 3 },
    { id: 'a5f9532e-a836-455c-9c8c-3df906615a5b', name: 'NACIONAL', orden: 4 },
    { id: 'f63125c2-025f-4122-89f0-14f3c80ac0ca', name: 'CANINDO', orden: 5 },
  ];
  
  // Only insert if zones table is empty
  const existingZoneCount = await knex('zones').count('id as count').first();
  if (existingZoneCount && existingZoneCount.count === '0') {
    await knex('zones').insert(defaultZones);
  }

  // 3. Add zona_id to users and stores
  await knex.schema.alterTable('users', (table) => {
    table.uuid('zona_id').references('id').inTable('zones');
  });

  await knex.schema.alterTable('stores', (table) => {
    table.uuid('zona_id').references('id').inTable('zones');
  });

  // 4. Populate zona_id by matching string value
  // First, update users
  await knex.raw(`
    UPDATE users 
    SET zona_id = zones.id 
    FROM zones 
    WHERE users.zona = zones.name
    AND users.zona IS NOT NULL
    AND users.zona != ''
  `);

  // Then update stores
  await knex.raw(`
    UPDATE stores 
    SET zona_id = zones.id 
    FROM zones 
    WHERE stores.zona = zones.name
    AND stores.zona IS NOT NULL
    AND stores.zona != ''
  `);

  // 5. Create a report of records that couldn't be matched
  const unmatchedUsers = await knex('users')
    .whereNull('zona_id')
    .whereNotNull('zona')
    .select('id', 'username', 'zona');
  
  const unmatchedStores = await knex('stores')
    .whereNull('zona_id')
    .whereNotNull('zona')
    .select('id', 'nombre', 'zona');

  if (unmatchedUsers.length > 0 || unmatchedStores.length > 0) {
    console.log('[refactor_zones] WARNING: Some records could not be matched to zones:');
    if (unmatchedUsers.length > 0) {
      console.log('  Unmatched users:', unmatchedUsers.map(u => `${u.username} (${u.zona})`).join(', '));
    }
    if (unmatchedStores.length > 0) {
      console.log('  Unmatched stores:', unmatchedStores.map(s => `${s.nombre} (${s.zona})`).join(', '));
    }
  }

  // 6. Cleanup: We avoid deleting from catalogs here because it can trigger 
  // CASCADE deletes on Rutas that might be referenced by daily_assignments.
  // The seeds will handle creating a clean state for fresh installs.
  // await knex('catalogs').where({ catalog_id: 'zonas' }).delete();
  
  // 7. We keep the 'zona' string columns for now as 'legacy' to avoid breaking code 
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
