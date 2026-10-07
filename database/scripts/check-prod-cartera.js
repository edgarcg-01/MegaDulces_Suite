"use strict";

/**
 * Verificación READ-ONLY de los datos que alimentan "Cartera de ventas":
 * commercial.customers.sales_route + commercial.vendor_sales_routes.
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/check-prod-cartera.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const tot = await c.query(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE deleted_at IS NULL)::int activos,
           count(*) FILTER (WHERE sales_route IS NOT NULL AND deleted_at IS NULL)::int con_ruta,
           count(*) FILTER (WHERE visit_sequence IS NOT NULL AND deleted_at IS NULL)::int con_secuencia
    FROM commercial.customers`);
  console.log('commercial.customers:', tot.rows[0]);

  const routes = await c.query(`
    SELECT sales_route, count(*)::int n
    FROM commercial.customers
    WHERE sales_route IS NOT NULL AND deleted_at IS NULL
    GROUP BY sales_route ORDER BY sales_route LIMIT 40`);
  console.log(`\nDISTINCT sales_route (${routes.rows.length} mostradas):`);
  if (!routes.rows.length) console.log('  (NINGUNA — customers.sales_route está vacío) ← causa de "no muestra nada"');
  for (const r of routes.rows) console.log(`  ${r.sales_route} -> ${r.n} clientes`);

  const vsr = await c.query(`SELECT count(*)::int n FROM commercial.vendor_sales_routes`);
  console.log(`\nvendor_sales_routes (asignaciones existentes): ${vsr.rows[0].n}`);

  // Muestra cómo lucen 5 customers (para ver si sales_route viene en otra forma)
  const sample = await c.query(`
    SELECT code, name, sales_route, visit_sequence
    FROM commercial.customers WHERE deleted_at IS NULL ORDER BY code LIMIT 5`);
  console.log('\nmuestra de 5 customers:');
  for (const s of sample.rows) console.log(`  ${s.code} | ruta=${JSON.stringify(s.sales_route)} | seq=${s.visit_sequence} | ${s.name}`);

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
