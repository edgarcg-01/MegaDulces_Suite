"use strict";

/**
 * READ-ONLY: verifica el cruce que hace el home del vendedor para joaquin_hurtado.
 *   home: customers WHERE EXISTS (vendor_sales_routes vsr
 *         WHERE vsr.sales_route = c.sales_route AND vsr.user_id = <joaquin>)
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/check-prod-joaquin.js
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const USER = process.env.VENDOR_USERNAME || 'joaquin_hurtado';

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const cust = await c.query(`
    SELECT count(*) FILTER (WHERE sales_route IS NOT NULL)::int con_ruta,
           count(*)::int total
    FROM commercial.customers WHERE deleted_at IS NULL`);
  console.log('customers:', cust.rows[0], '(si con_ruta=0 → el backfill NO corrió)');

  const u = await c.query(
    `SELECT id, username, role_name, tenant_id FROM public.users WHERE username = $1`, [USER]);
  console.log(`\nuser ${USER}:`, u.rows[0] || 'NO ENCONTRADO');

  const asg = await c.query(`
    SELECT vsr.id, vsr.user_id, vsr.sales_route, vsr.tenant_id, u.username
    FROM commercial.vendor_sales_routes vsr
    LEFT JOIN public.users u ON u.id = vsr.user_id
    ORDER BY u.username`);
  console.log(`\nvendor_sales_routes (${asg.rows.length} asignaciones totales):`);
  for (const a of asg.rows) console.log(`  ${a.username || '??'} -> ${JSON.stringify(a.sales_route)} (user_id=${a.user_id})`);

  // El cruce exacto del home, por asignación de este usuario
  const match = await c.query(`
    SELECT vsr.sales_route AS ruta_asignada,
      (SELECT count(*)::int FROM commercial.customers c
       WHERE c.deleted_at IS NULL AND c.sales_route = vsr.sales_route) AS clientes_match
    FROM commercial.vendor_sales_routes vsr
    JOIN public.users u ON u.id = vsr.user_id
    WHERE u.username = $1`, [USER]);
  console.log(`\ncruce home para ${USER}:`);
  if (!match.rows.length) console.log('  (sin asignaciones para este user)');
  for (const m of match.rows) console.log(`  ruta="${m.ruta_asignada}" -> ${m.clientes_match} clientes match`);

  // Por si hay mismatch de formato: rutas en customers que se PARECEN a las asignadas
  const distinctCust = await c.query(`
    SELECT DISTINCT sales_route FROM commercial.customers
    WHERE deleted_at IS NULL AND sales_route IS NOT NULL ORDER BY sales_route LIMIT 30`);
  console.log('\nsales_route DISTINTOS en customers:', distinctCust.rows.map((r) => JSON.stringify(r.sales_route)).join(', ') || '(ninguno)');

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
