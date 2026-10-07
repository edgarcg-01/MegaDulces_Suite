/** DIAGNÓSTICO (read-only) — ¿hay breadcrumbs GPS para dibujar en /dashboard/routes? */
const path = require('path');
const knex = require(path.join(__dirname, '..', '..', 'node_modules', 'knex'));
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }
const db = knex({ client: 'pg', connection: { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }, pool: { min: 0, max: 4 } });

(async () => {
  try {
    const tot = await db.raw(`
      SELECT count(*)::int total,
             count(route_id)::int con_route_id,
             count(*) FILTER (WHERE route_id IS NULL)::int sin_route_id,
             count(DISTINCT user_id)::int usuarios,
             to_char(min(captured_at),'YYYY-MM-DD') primera,
             to_char(max(captured_at),'YYYY-MM-DD') ultima
      FROM public.route_location_pings`);
    console.log('=== route_location_pings (totales) ===');
    console.table(tot.rows);

    const byRoute = await db.raw(`
      SELECT c.value AS route, count(*)::int pings, count(DISTINCT p.user_id)::int usuarios,
             to_char(max(p.captured_at),'YYYY-MM-DD') ultima
      FROM public.route_location_pings p
      LEFT JOIN catalogs c ON c.id = p.route_id AND c.catalog_id='rutas'
      WHERE p.route_id IS NOT NULL
      GROUP BY c.value ORDER BY pings DESC LIMIT 10`);
    console.log('=== pings con route_id (los que el mapa dibuja por ruta) ===');
    console.table(byRoute.rows);
  } catch (e) { console.error('ERROR:', e.message); process.exitCode = 1; }
  finally { await db.destroy(); }
})();
