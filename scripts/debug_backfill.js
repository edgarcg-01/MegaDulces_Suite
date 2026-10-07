const knex = require('knex');
const config = require('../database/knexfile.js');
const env = process.env.NODE_ENV || 'production';
const db = knex(config[env]);

(async () => {
  try {
    const dc = await db('daily_captures').whereNull('store_id').first();
    console.log('Sample DC id:', dc.id);
    console.log('Sample DC user_id:', dc.user_id);
    console.log('Sample DC fecha:', dc.fecha);
    console.log('Sample DC fecha type:', typeof dc.fecha);
    console.log('Sample DC fecha ISO:', dc.fecha instanceof Date ? dc.fecha.toISOString() : dc.fecha);

    const fechaStr = dc.fecha instanceof Date 
      ? dc.fecha.toISOString().split('T')[0] 
      : String(dc.fecha).split('T')[0];
    console.log('Looking for visits on date:', fechaStr);

    // Check ALL visits for this user regardless of date
    const allVisits = await db('visits')
      .where('user_id', dc.user_id)
      .select('id','store_id','user_id','checkin_at')
      .limit(5);
    console.log('Any visits for this user:', JSON.stringify(allVisits, null, 2));
    console.log('Total visits for user:', (await db('visits').where('user_id', dc.user_id).count('id as c').first()).c);

    // Try with raw SQL for date comparison
    const matchingVisits = await db.raw(`
      SELECT id, store_id, user_id, checkin_at::date as checkin_date
      FROM visits 
      WHERE user_id = ?
        AND checkin_at::date = ?::date
      LIMIT 5
    `, [dc.user_id, fechaStr]);
    console.log('Matching visits (raw):', JSON.stringify(matchingVisits.rows, null, 2));
    console.log('Matching count:', matchingVisits.rows.length);

    // Check a specific visit
    const oneVisit = await db('visits').select('id','store_id','user_id','checkin_at').first();
    console.log('One visit:', JSON.stringify(oneVisit, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  } finally {
    await db.destroy();
  }
})();
