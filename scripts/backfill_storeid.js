const knex = require('knex');
const config = require('../database/knexfile.js');
const env = process.env.NODE_ENV || 'production';
const db = knex(config[env]);

(async () => {
  try {
    // Get all stores and their zone names
    const stores = await db('stores as s')
      .leftJoin('zones as z', 'z.id', 's.zona_id')
      .select('s.id', 's.nombre', 'z.name as zona_name');

    console.log('Available stores:');
    stores.forEach(s => console.log(`  ${s.id} -> ${s.nombre} (zona: ${s.zona_name})`));

    let totalBackfilled = 0;

    for (const store of stores) {
      if (!store.zona_name) continue;

      const result = await db.raw(`
        UPDATE daily_captures 
        SET store_id = ?
        WHERE store_id IS NULL
          AND zona_captura ILIKE ?
      `, [store.id, store.zona_name]);

      if (result.rowCount > 0) {
        console.log(`Backfilled ${result.rowCount} captures for store "${store.nombre}" (zona: ${store.zona_name})`);
        totalBackfilled += result.rowCount;
      }
    }

    const remaining = await db('daily_captures').whereNull('store_id').count('id as c').first();
    console.log(`\nTotal backfilled: ${totalBackfilled}`);
    console.log('Remaining without store_id:', remaining?.c || 0);

    const withStore = await db('daily_captures').whereNotNull('store_id').count('id as c').first();
    console.log('With store_id:', withStore?.c || 0);

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await db.destroy();
  }
})();
