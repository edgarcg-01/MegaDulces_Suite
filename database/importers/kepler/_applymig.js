const path = require('path');
const knexLib = require('knex');
const NAME = '20260721160000_analytics_sales_by_vendor_monthly.js';
(async () => {
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: process.env.U, ssl: { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });
  try {
    const already = await db('public.knex_migrations').where({ name: NAME }).first();
    if (already) { console.log('ya aplicada — nada que hacer'); return; }
    const mig = require(path.resolve(__dirname, '..', '..', 'migrations-newdb', NAME));
    console.log('corriendo up()…');
    await mig.up(db);
    const { max } = (await db('public.knex_migrations').max('batch as max'))[0];
    const batch = (Number(max) || 0) + 1;
    await db('public.knex_migrations').insert({ name: NAME, batch, migration_time: db.fn.now() });
    console.log(`OK — migración registrada en batch ${batch}`);
    const t = await db.raw(`SELECT count(*)::int n FROM analytics.sales_by_vendor_monthly`);
    console.log('tabla creada, filas:', t.rows[0].n);
  } finally { await db.destroy(); }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
