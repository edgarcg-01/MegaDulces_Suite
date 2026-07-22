const { Client } = require('pg');
const NAME = '20260721160000_analytics_sales_by_vendor_monthly.js';
(async () => {
  const db = new Client({ connectionString: process.env.U, ssl: { rejectUnauthorized: false }, statement_timeout: 120000, keepAlive: true });
  await db.connect();
  // 1) drop invalid BRIN
  await db.query(`DROP INDEX IF EXISTS wincaja.ix_wcj_maestro_fecha_brin`);
  console.log('BRIN inválido dropeado');
  // 2) verify table indexes + grant exist (up() los alcanzó antes del timeout)
  const idx = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname='analytics' AND tablename='sales_by_vendor_monthly' ORDER BY 1`);
  console.log('índices tabla:', idx.rows.map(r => r.indexname).join(', ') || 'NINGUNO');
  // ensure grant (idempotent)
  await db.query(`GRANT SELECT ON analytics.sales_by_vendor_monthly TO app_runtime`);
  // 3) record migration
  const ex = await db.query(`SELECT 1 FROM public.knex_migrations WHERE name=$1`, [NAME]);
  if (!ex.rows.length) {
    const b = (await db.query(`SELECT COALESCE(max(batch),0)+1 b FROM public.knex_migrations`)).rows[0].b;
    await db.query(`INSERT INTO public.knex_migrations (name, batch, migration_time) VALUES ($1,$2,now())`, [NAME, b]);
    console.log(`migración registrada en batch ${b}`);
  } else console.log('migración ya registrada');
  await db.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
