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

  // STEP 1: Insert all zones with correct UUIDs first
  for (const zone of fixedZones) {
    const existingCorrect = await knex('zones').where({ id: zone.id }).first();
    if (existingCorrect) {
      console.log(`[fix_zones_uuids] Zone ${zone.name} already has correct UUID`);
      continue;
    }

    // Check if zone exists with wrong ID
    const existingByName = await knex('zones').where({ name: zone.name }).first();
    
    if (existingByName) {
      // Zone exists with wrong ID - temporarily rename old zone to avoid unique constraint
      await knex('zones').where({ id: existingByName.id }).update({ name: `${zone.name}_OLD` });
      console.log(`[fix_zones_uuids] Renamed old zone ${zone.name} to ${zone.name}_OLD`);
    }
    
    // Insert zone with correct ID
    await knex('zones').insert(zone);
    console.log(`[fix_zones_uuids] Inserted zone ${zone.name} with correct UUID`);
  }

  // STEP 2: Update foreign key references from old zones to new ones and delete old zones
  for (const zone of fixedZones) {
    // Find the old zone (with _OLD suffix)
    const oldZone = await knex('zones').where({ name: `${zone.name}_OLD` }).first();
    
    if (!oldZone) {
      // Check if there's a zone with a different ID (not correct, not _OLD)
      const wrongZone = await knex('zones').where({ name: zone.name }).whereNot({ id: zone.id }).first();
      if (!wrongZone) {
        console.log(`[fix_zones_uuids] No old zone to migrate for ${zone.name}`);
        continue;
      }
      
      // Found a zone with wrong ID but not renamed - rename it now
      await knex('zones').where({ id: wrongZone.id }).update({ name: `${zone.name}_OLD` });
      console.log(`[fix_zones_uuids] Renamed wrong zone ${zone.name} to ${zone.name}_OLD`);
      oldZone = wrongZone;
    }

    const oldId = oldZone.id;
    console.log(`[fix_zones_uuids] Migrating references from ${zone.name}_OLD (${oldId}) -> ${zone.name} (${zone.id})`);

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

    // Delete old zone record
    await knex('zones').where({ id: oldId }).delete();
    console.log(`[fix_zones_uuids] Deleted old zone ${zone.name}_OLD with ID ${oldId}`);
  }

  console.log('[fix_zones_uuids] Zones UUID fix completed');
};

exports.down = async function(knex) {
  // This migration is not reversible as we can't know the old random UUIDs
  console.log('[fix_zones_uuids] Down migration not available - UUIDs were fixed permanently');
};
