"use strict";
/**
 * Diagnóstico READ-ONLY contra prod: por qué (1) el cliente que registró el
 * vendedor no se muestra y (2) el backend de vendor "casi no arroja info".
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/diag-angel-prod.js
 * NO hace writes.
 */
const { Client } = require('pg');
const URL = process.env.PROD_DATABASE_URL;
if (!URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

const COMMERCIAL_PERMS = [
  'VENDOR_APP_ACCESS', 'COMMERCIAL_CUSTOMERS_VER', 'COMMERCIAL_PRICING_VER',
  'COMMERCIAL_INVENTORY_VER', 'COMMERCIAL_ORDERS_VER', 'COMMERCIAL_ORDERS_CREAR',
  'COMMERCIAL_PAYMENTS_REGISTRAR', 'VISITAS_REGISTRAR', 'CAPTURE_TICKET_USE',
];

(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const section = (t) => console.log(`\n===== ${t} =====`);

  // 1. Usuario(s) angel
  section('USUARIO angel');
  const u = await c.query(
    `SELECT id, username, role_name, customer_id, zona_id, activo, tenant_id
       FROM public.users WHERE username ILIKE '%angel%' ORDER BY username`);
  console.table(u.rows.map(r => ({ username: r.username, role: r.role_name, activo: r.activo, customer_id: r.customer_id })));
  const angel = u.rows[0];
  if (!angel) { console.log('NO se encontró usuario angel'); await c.end(); return; }

  // 2. Permisos del rol de angel
  section(`PERMISOS del rol '${angel.role_name}'`);
  const rp = await c.query(`SELECT permissions FROM public.role_permissions WHERE role_name = $1 LIMIT 1`, [angel.role_name]);
  const perms = rp.rows[0]?.permissions || {};
  const total = Object.keys(perms).filter(k => perms[k]).length;
  console.log(`total permisos true: ${total}`);
  for (const p of COMMERCIAL_PERMS) console.log(`  ${perms[p] === true ? '✓' : '✗ FALTA'}  ${p}`);

  // 3. Clientes creados desde la app (code V-%)
  section('CLIENTES creados desde la app (code V-%)');
  const vc = await c.query(
    `SELECT code, name, sales_route, visit_days, default_price_list_id IS NOT NULL AS tiene_pricelist,
            latitude IS NOT NULL AS tiene_geo, active, deleted_at, created_at
       FROM commercial.customers WHERE code LIKE 'V-%' ORDER BY created_at DESC LIMIT 15`);
  console.log(`encontrados: ${vc.rows.length}`);
  console.table(vc.rows.map(r => ({ code: r.code, name: (r.name||'').slice(0,24), sales_route: r.sales_route, visit_days: JSON.stringify(r.visit_days), pricelist: r.tiene_pricelist, geo: r.tiene_geo, active: r.active, del: !!r.deleted_at })));

  // 4. Cartera del vendedor: daily_assignments de angel
  section('CARTERA — daily_assignments de angel (todas)');
  const da = await c.query(
    `SELECT da.day_of_week, cat.value AS ruta
       FROM public.daily_assignments da
       JOIN public.catalogs cat ON cat.id = da.route_id AND cat.catalog_id='rutas' AND cat.deleted_at IS NULL
      WHERE da.user_id = $1 ORDER BY da.day_of_week`, [angel.id]);
  console.log(`asignaciones: ${da.rows.length}`);
  console.table(da.rows);

  // 5. ¿Cuántos clientes matchean la cartera de angel HOY? (replica vendor-cartera.sql)
  section('MATCH cartera HOY (lo que vería "Mi ruta")');
  const match = await c.query(
    `SELECT count(*)::int n FROM commercial.customers c
      WHERE c.deleted_at IS NULL
        AND c.visit_days @> ARRAY[EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::smallint]
        AND EXISTS (
          SELECT 1 FROM public.daily_assignments da
          JOIN public.catalogs cat ON cat.id = da.route_id AND cat.catalog_id='rutas' AND cat.deleted_at IS NULL
          WHERE da.user_id = $1 AND cat.value = c.sales_route
            AND da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int)`, [angel.id]);
  console.log(`clientes en "Mi ruta" hoy (filtro ACTUAL): ${match.rows[0].n}`);
  const match2 = await c.query(
    `SELECT count(*)::int n FROM commercial.customers c
      WHERE c.deleted_at IS NULL
        AND (c.visit_days IS NULL OR cardinality(c.visit_days)=0
             OR c.visit_days @> ARRAY[EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::smallint])
        AND EXISTS (
          SELECT 1 FROM public.daily_assignments da
          JOIN public.catalogs cat ON cat.id = da.route_id AND cat.catalog_id='rutas' AND cat.deleted_at IS NULL
          WHERE da.user_id = $1 AND cat.value = c.sales_route
            AND da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int)`, [angel.id]);
  console.log(`clientes en "Mi ruta" hoy (filtro NUEVO, visit_days opcional): ${match2.rows[0].n}`);

  // 6. Stats globales de customers
  section('STATS commercial.customers (tenant de angel)');
  const st = await c.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE visit_days IS NOT NULL AND cardinality(visit_days)>0)::int con_visit_days,
            count(*) FILTER (WHERE sales_route IS NOT NULL)::int con_sales_route
       FROM commercial.customers WHERE deleted_at IS NULL AND tenant_id = $1`, [angel.tenant_id]);
  console.table(st.rows);

  // 7. Price list default
  section('PRICE LISTS');
  const pl = await c.query(`SELECT code, is_default, active FROM commercial.price_lists WHERE deleted_at IS NULL`);
  console.table(pl.rows);

  // 8. Gap de cartera en las rutas de angel (total vs con visit_days)
  section('GAP de cartera por ruta de angel');
  const gap = await c.query(
    `SELECT c.sales_route,
            count(*)::int total,
            count(*) FILTER (WHERE c.visit_days IS NOT NULL AND cardinality(c.visit_days)>0)::int con_visit_days
       FROM commercial.customers c
      WHERE c.deleted_at IS NULL AND c.tenant_id = $1
        AND c.sales_route IN (
          SELECT DISTINCT cat.value FROM public.daily_assignments da
          JOIN public.catalogs cat ON cat.id=da.route_id AND cat.catalog_id='rutas' AND cat.deleted_at IS NULL
          WHERE da.user_id = $2)
      GROUP BY c.sales_route ORDER BY c.sales_route`, [angel.tenant_id, angel.id]);
  console.table(gap.rows);

  await c.end();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
