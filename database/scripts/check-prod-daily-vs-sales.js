"use strict";

/**
 * READ-ONLY: ¿daily_assignments (trade) mapea a customers.sales_route (comercial)?
 *   daily_assignments.route_id -> catalogs.value (route_name)  ¿==  customers.sales_route?
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/check-prod-daily-vs-sales.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const USER = process.env.VENDOR_USERNAME || 'joaquin_hurtado';

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const rutas = await c.query(`
    SELECT value, count(*)::int n
    FROM catalogs WHERE catalog_id='rutas' AND deleted_at IS NULL
    GROUP BY value ORDER BY value LIMIT 40`);
  console.log('catalogs (rutas) — valores:');
  for (const r of rutas.rows) console.log(`  ${JSON.stringify(r.value)}`);

  const da = await c.query(`
    SELECT da.day_of_week, c.value AS route_name, da.status
    FROM daily_assignments da
    JOIN catalogs c ON c.id = da.route_id
    JOIN users u ON u.id = da.user_id
    WHERE u.username = $1
    ORDER BY da.day_of_week`, [USER]);
  console.log(`\ndaily_assignments de ${USER} (${da.rows.length}):`);
  for (const r of da.rows) console.log(`  dia=${r.day_of_week} ruta=${JSON.stringify(r.route_name)} status=${r.status}`);

  // ¿el route_name asignado mapea a customers.sales_route?
  console.log('\nmatch route_name -> customers.sales_route:');
  for (const r of da.rows) {
    const exact = await c.query(
      `SELECT count(*)::int n FROM commercial.customers WHERE deleted_at IS NULL AND sales_route = $1`,
      [r.route_name]);
    const ci = await c.query(
      `SELECT count(*)::int n FROM commercial.customers WHERE deleted_at IS NULL AND upper(trim(sales_route)) = upper(trim($1))`,
      [r.route_name]);
    console.log(`  ${JSON.stringify(r.route_name)} -> exacto:${exact.rows[0].n}  case-insensitive:${ci.rows[0].n}`);
  }

  // panorama: sales_route distintos en customers
  const sr = await c.query(`
    SELECT DISTINCT sales_route FROM commercial.customers
    WHERE deleted_at IS NULL AND sales_route IS NOT NULL ORDER BY sales_route`);
  console.log('\ncustomers.sales_route distintos:', sr.rows.map((r) => JSON.stringify(r.sales_route)).join(', '));

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
