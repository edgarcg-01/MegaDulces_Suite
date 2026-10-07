"use strict";

/**
 * READ-ONLY: ¿cuál es el vínculo real cliente↔ruta? Compara:
 *   - code LIKE '27%'      (prefijo del código del ERP = vendedor/ruta)
 *   - sales_route='RUTA 27'(lo que pobló el backfill desde notes)
 * y busca por nombre los clientes de la captura del ERP (vendedor 27).
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/check-prod-ruta27-model.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const counts = await c.query(`
    SELECT
      count(*) FILTER (WHERE code LIKE '27%')::int                       AS code_27pct,
      count(*) FILTER (WHERE sales_route = 'RUTA 27')::int               AS sr_ruta27,
      count(*) FILTER (WHERE code LIKE '27%' AND sales_route='RUTA 27')::int AS ambos,
      count(*) FILTER (WHERE code LIKE '27%' AND sales_route IS DISTINCT FROM 'RUTA 27')::int AS code27_otro_sr
    FROM commercial.customers WHERE deleted_at IS NULL`);
  console.log('conteos:', counts.rows[0]);

  console.log('\nclientes con code LIKE 27% (la cartera del vendedor 27 segun ERP):');
  const code27 = await c.query(`
    SELECT code, name, sales_route, left(notes,40) AS notes
    FROM commercial.customers WHERE deleted_at IS NULL AND code LIKE '27%'
    ORDER BY code LIMIT 40`);
  for (const r of code27.rows) console.log(`  ${r.code} | sr=${JSON.stringify(r.sales_route)} | ${r.name} | notes=${JSON.stringify(r.notes)}`);

  console.log('\nbusqueda por nombre (clientes de la captura):');
  const names = await c.query(`
    SELECT code, name, sales_route
    FROM commercial.customers WHERE deleted_at IS NULL AND (
      name ILIKE '%ana bertha martinez%' OR name ILIKE '%hecelchakan%' OR
      name ILIKE '%blanca e_pinoza%' OR name ILIKE '%secundaria ecuandureo%' OR
      name ILIKE '%cajulsa%' OR name ILIKE '%nueva operadora comercial%' OR
      name ILIKE '%magaly pimentel%' OR name ILIKE '%mirian gallardo%')
    ORDER BY name LIMIT 40`);
  for (const r of names.rows) console.log(`  ${r.code} | sr=${JSON.stringify(r.sales_route)} | ${r.name}`);

  console.log('\nmuestra de los que tienen sales_route=RUTA 27 pero code NO empieza en 27:');
  const mismatch = await c.query(`
    SELECT code, name, sales_route, left(notes,40) AS notes
    FROM commercial.customers WHERE deleted_at IS NULL
      AND sales_route='RUTA 27' AND code NOT LIKE '27%'
    ORDER BY code LIMIT 20`);
  for (const r of mismatch.rows) console.log(`  ${r.code} | ${r.name} | notes=${JSON.stringify(r.notes)}`);

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
