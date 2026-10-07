"use strict";
/** READ-ONLY: valores reales de lat/lng de los clientes creados desde la app. */
const { Client } = require('pg');
const URL = process.env.PROD_DATABASE_URL;
if (!URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(
    `SELECT code, name, latitude, longitude,
            pg_typeof(latitude) AS lat_type, pg_typeof(longitude) AS lng_type, created_at
       FROM commercial.customers
      WHERE code LIKE 'V-%' OR created_at > now() - interval '7 days'
      ORDER BY created_at DESC LIMIT 20`);
  console.table(r.rows.map(x => ({
    code: x.code, name: (x.name||'').slice(0,20),
    latitude: x.latitude, longitude: x.longitude,
    lat_type: x.lat_type, lng_type: x.lng_type,
  })));

  const tot = await c.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int con_geo
       FROM commercial.customers WHERE deleted_at IS NULL`);
  console.log('\nCustomers con coordenadas (global):', tot.rows[0]);

  const byRoute = await c.query(
    `SELECT sales_route, count(*)::int total,
            count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int con_geo
       FROM commercial.customers
      WHERE deleted_at IS NULL AND sales_route IN ('RUTA 27','RUTA 28','RUTA 23')
      GROUP BY sales_route ORDER BY sales_route`);
  console.log('Por rutas de angel (autodetección busca acá):');
  console.table(byRoute.rows);

  await c.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
