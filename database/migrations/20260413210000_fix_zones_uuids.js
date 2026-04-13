/**
 * Fix zones UUIDs to match fixed values from seeds
 * This ensures consistency between production data and code expectations
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Fixed UUIDs that must match seeds/00a_zones.js
  const fixedZones = [
    { id: 'fb136f01-5efe-4c9f-b297-48f06574002c', name: 'LA PIEDAD', orden: 1 },
    { id: 'b3e5d1cf-bf7e-419f-9037-b02f070bd2bc', name: 'ZAMORA', orden: 2 },
    { id: '2107b482-7d3a-4c82-9377-c9f2427e699e', name: 'MORELIA', orden: 3 },
    { id: 'a5f9532e-a836-455c-9c8c-3df906615a5b', name: 'NACIONAL', orden: 4 },
    { id: 'f63125c2-025f-4122-89f0-14f3c80ac0ca', name: 'CANINDO', orden: 5 },
  ];

  console.log('[fix_zones_uuids] Checking zones UUID consistency...');

  for (const zone of fixedZones) {
    // Check if zone exists with the correct ID
    const existingCorrect = await knex('zones').where({ id: zone.id }).first();
    
    if (existingCorrect) {
      console.log(`[fix_zones_uuids] Zone ${zone.name} already has correct UUID`);
      continue;
    }

    // Check if zone exists with a different ID (old random UUID)
    const existingByName = await knex('zones').where({ name: zone.name }).first();
    
    if (existingByName) {
      const oldId = existingByName.id;
      console.log(`[fix_zones_uuids] Zone ${zone.name} has wrong UUID: ${oldId} -> ${zone.id}`);

      // Update foreign key references in users table
      const updatedUsers = await knex('users')
        .where({ zona_id: oldId })
        .update({ zona_id: zone.id });
      console.log(`[fix_zones_uuids] Updated ${updatedUsers} users`);

      // Update foreign key references in stores table
      const updatedStores = await knex('stores')
        .where({ zona_id: oldId })
        .update({ zona_id: zone.id });
      console.log(`[fix_zones_uuids] Updated ${updatedStores} stores`);

      // Delete old zone record and insert with correct ID
      await knex('zones').where({ id: oldId }).delete();
      await knex('zones').insert(zone);
      console.log(`[fix_zones_uuids] Replaced zone ${zone.name}`);
    } else {
      // Zone doesn't exist at all, insert it
      await knex('zones').insert(zone);
      console.log(`[fix_zones_uuids] Inserted missing zone ${zone.name}`);
    }
  }

  console.log('[fix_zones_uuids] Zones UUID fix completed');
};

exports.down = async function(knex) {
  // This migration is not reversible as we can't know the old random UUIDs
  console.log('[fix_zones_uuids] Down migration not available - UUIDs were fixed permanently');
};
