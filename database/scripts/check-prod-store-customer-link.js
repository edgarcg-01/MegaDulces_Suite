"use strict";
/** READ-ONLY: estado del vínculo tienda(stores)↔cliente(customers) + ubicaciones. */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const cust = await c.query(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE store_id IS NOT NULL)::int con_store_id,
           count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int con_coords
    FROM commercial.customers WHERE deleted_at IS NULL`);
  console.log('commercial.customers (activos):', cust.rows[0]);

  const stores = await c.query(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE latitud IS NOT NULL AND latitud <> 0)::int con_coords
    FROM public.stores WHERE activo = true`);
  console.log('public.stores (activas):', stores.rows[0]);

  const linked = await c.query(`
    SELECT count(*)::int stores_con_customer
    FROM public.stores s
    WHERE s.activo = true
      AND EXISTS (SELECT 1 FROM commercial.customers c
                  WHERE c.store_id = s.id AND c.deleted_at IS NULL)`);
  console.log('stores con customer vinculado:', linked.rows[0]);

  // De los customers vinculados a un store: ¿tienen coords propias? ¿coinciden con el store?
  const coords = await c.query(`
    SELECT
      count(*)::int vinculados,
      count(*) FILTER (WHERE c.latitude IS NOT NULL)::int customer_con_coords,
      count(*) FILTER (WHERE s.latitud IS NOT NULL AND s.latitud <> 0)::int store_con_coords,
      count(*) FILTER (WHERE c.latitude IS NOT NULL AND s.latitud IS NOT NULL
                        AND round(c.latitude::numeric,5) = round(s.latitud::numeric,5)
                        AND round(c.longitude::numeric,5) = round(s.longitud::numeric,5))::int coords_coinciden
    FROM commercial.customers c
    JOIN public.stores s ON s.id = c.store_id
    WHERE c.deleted_at IS NULL`);
  console.log('\ncustomers vinculados a store:', coords.rows[0]);

  // ¿Cuántos customers de la ruta 27 (los del piloto) tienen store_id y coords?
  const r27 = await c.query(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE store_id IS NOT NULL)::int con_store_id,
           count(*) FILTER (WHERE latitude IS NOT NULL)::int con_coords
    FROM commercial.customers WHERE deleted_at IS NULL AND sales_route = 'RUTA 27'`);
  console.log('\ncustomers RUTA 27:', r27.rows[0]);

  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
