const knex = require('knex');
const config = require('../database/knexfile.js');
const env = process.env.NODE_ENV || 'production';
const db = knex(config[env]);

(async () => {
  try {
    // 1. Add store_id column to daily_captures
    const hasColumn = await db.schema.hasColumn('daily_captures', 'store_id');
    if (!hasColumn) {
      await db.schema.alterTable('daily_captures', (table) => {
        table.uuid('store_id').nullable().references('id').inTable('stores').onDelete('SET NULL');
      });
      console.log('Migration applied: added store_id to daily_captures');
      await db('knex_migrations').insert({
        name: '20260508000000_add_store_id_to_daily_captures.js',
        batch: 999,
        migration_time: new Date(),
      });
      console.log('Marked migration in knex_migrations');
    } else {
      console.log('store_id already exists on daily_captures');
    }

    // 2. Backfill: match daily_captures with visits by user_id + fecha
    const nullStoreCount = await db('daily_captures').whereNull('store_id').count('id as c').first();
    console.log('Daily captures without store_id:', nullStoreCount?.c || 0);

    if (Number(nullStoreCount?.c || 0) > 0) {
      // For each daily_capture without store_id, find the visit on the same day by the same user
      const backfilled = await db.raw(`
        UPDATE daily_captures dc
        SET store_id = subq.store_id
        FROM (
          SELECT DISTINCT ON (dc2.id) dc2.id as dc_id, v.store_id
          FROM daily_captures dc2
          JOIN visits v ON v.user_id = dc2.user_id 
            AND v.checkin_at::date = dc2.fecha
          WHERE dc2.store_id IS NULL
          ORDER BY dc2.id, v.checkin_at DESC
        ) subq
        WHERE dc.id = subq.dc_id
      `);
      console.log('Backfilled rows:', backfilled.rowCount || 0);
    }

    // Check remaining
    const remaining = await db('daily_captures').whereNull('store_id').count('id as c').first();
    console.log('Remaining without store_id:', remaining?.c || 0);

    if (Number(remaining?.c || 0) > 0) {
      const examples = await db('daily_captures')
        .whereNull('store_id')
        .select('id', 'folio', 'user_id', 'fecha')
        .limit(5);
      console.log('Unmatched captures:', JSON.stringify(examples, null, 2));
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await db.destroy();
  }
})();
