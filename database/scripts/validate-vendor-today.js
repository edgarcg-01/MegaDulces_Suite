"use strict";

/**
 * READ-ONLY: valida el read-through nuevo (cartera del vendedor = ruta de HOY
 * desde daily_assignments) replicando el EXISTS contra prod, antes de deployar.
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/validate-vendor-today.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const JOAQUIN = '413e02ec-0691-464c-ad11-d3e5cfe2113f';

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const today = await c.query(
    `SELECT EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int AS isodow,
            (now() AT TIME ZONE 'America/Mexico_City')::date AS fecha_mx`);
  console.log('hoy MX:', today.rows[0], '(isodow 1=lun..7=dom)');

  const r = await c.query(`
    SELECT count(*)::int n FROM commercial.customers c
    WHERE c.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.daily_assignments da
        JOIN public.catalogs cat
          ON cat.id = da.route_id AND cat.catalog_id='rutas' AND cat.deleted_at IS NULL
        WHERE da.user_id = $1
          AND cat.value = c.sales_route
          AND da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int
      )`, [JOAQUIN]);
  console.log(`\n→ clientes en la cartera de joaquin HOY: ${r.rows[0].n}`);

  // desglose por día para contexto
  const wk = await c.query(`
    SELECT da.day_of_week, cat.value AS ruta,
      (SELECT count(*)::int FROM commercial.customers c
       WHERE c.deleted_at IS NULL AND c.sales_route = cat.value) AS clientes
    FROM public.daily_assignments da
    JOIN public.catalogs cat ON cat.id = da.route_id AND cat.catalog_id='rutas'
    WHERE da.user_id = $1 ORDER BY da.day_of_week`, [JOAQUIN]);
  console.log('\nsemana de joaquin:');
  const dias = { 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb', 7: 'Dom' };
  for (const x of wk.rows) console.log(`  ${dias[x.day_of_week]} → ${x.ruta} (${x.clientes} clientes)`);

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
