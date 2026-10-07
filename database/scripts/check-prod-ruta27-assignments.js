"use strict";
/** READ-ONLY: quién cubre RUTA 27 cada día (daily_assignments) + agenda de joaquin. */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const dias = { 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb', 7: 'Dom' };

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const r27 = await c.query(`
    SELECT da.day_of_week, u.username
    FROM daily_assignments da
    JOIN catalogs cat ON cat.id = da.route_id AND cat.catalog_id='rutas'
    JOIN users u ON u.id = da.user_id
    WHERE cat.value = 'RUTA 27' ORDER BY da.day_of_week`);
  console.log('quién tiene RUTA 27 por día:');
  if (!r27.rows.length) console.log('  (nadie)');
  for (const x of r27.rows) console.log(`  ${dias[x.day_of_week]} → ${x.username}`);

  const jo = await c.query(`
    SELECT da.day_of_week, cat.value AS ruta
    FROM daily_assignments da
    JOIN catalogs cat ON cat.id = da.route_id AND cat.catalog_id='rutas'
    JOIN users u ON u.id = da.user_id
    WHERE u.username = 'joaquin_hurtado' ORDER BY da.day_of_week`);
  console.log('\nagenda de joaquin_hurtado:');
  for (const x of jo.rows) console.log(`  ${dias[x.day_of_week]} → ${x.ruta}`);

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
