/**
 * DIAGNÓSTICO (read-only) — por qué stores.ruta_id está concentrado en una ruta.
 * Uso: DATABASE_URL='postgres://...' node database/scripts/check-prod-store-routes.js
 */
const path = require('path');
const knex = require(path.join(__dirname, '..', '..', 'node_modules', 'knex'));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 4 },
});

const p = (title) => console.log(`\n=== ${title} ===`);

(async () => {
  try {
    p('Totales de stores (activas)');
    const tot = await db.raw(`
      SELECT count(*)::int total,
             count(ruta_id)::int con_ruta,
             count(*) FILTER (WHERE ruta_id IS NULL)::int sin_ruta,
             count(DISTINCT ruta_id)::int rutas_distintas
      FROM stores WHERE deleted_at IS NULL`);
    console.table(tot.rows);

    p('Stores por ruta (top 15)');
    const dist = await db.raw(`
      SELECT c.value AS route_code, s.ruta_id, count(*)::int n
      FROM stores s
      LEFT JOIN catalogs c ON c.id = s.ruta_id AND c.catalog_id='rutas'
      WHERE s.deleted_at IS NULL
      GROUP BY c.value, s.ruta_id
      ORDER BY n DESC LIMIT 15`);
    console.table(dist.rows);

    p('Catálogo de rutas (cuántas definidas)');
    const cat = await db.raw(`
      SELECT count(*)::int total_rutas,
             count(*) FILTER (WHERE deleted_at IS NULL)::int activas
      FROM catalogs WHERE catalog_id='rutas'`);
    console.table(cat.rows);

    p('Las 15 rutas: orden, zona, fecha de creación, # stores');
    const rutas = await db.raw(`
      SELECT c.value, c.orden, to_char(c.created_at,'YYYY-MM-DD HH24:MI') creada,
             z.name AS zona,
             (SELECT count(*)::int FROM stores s WHERE s.ruta_id = c.id AND s.deleted_at IS NULL) stores
      FROM catalogs c
      LEFT JOIN zones z ON z.id = c.parent_id
      WHERE c.catalog_id='rutas'
      ORDER BY c.created_at, c.orden`);
    console.table(rutas.rows);

    p('stores.updated_at por día (¿barrido masivo?)');
    const upd = await db.raw(`
      SELECT to_char(updated_at,'YYYY-MM-DD') dia, count(*)::int n
      FROM stores WHERE deleted_at IS NULL AND updated_at IS NOT NULL
      GROUP BY 1 ORDER BY n DESC LIMIT 10`);
    console.table(upd.rows);

    p('daily_captures: route_id declarado (capturas, tiendas, capturadores, fechas)');
    const caps = await db.raw(`
      SELECT c.value AS route_code, count(*)::int capturas,
             count(DISTINCT dc.store_id)::int tiendas,
             count(DISTINCT dc.captured_by_username)::int capturadores,
             to_char(min(dc.created_at),'YYYY-MM-DD') primera,
             to_char(max(dc.created_at),'YYYY-MM-DD') ultima
      FROM daily_captures dc
      LEFT JOIN catalogs c ON c.id = dc.route_id AND c.catalog_id='rutas'
      WHERE dc.route_id IS NOT NULL
      GROUP BY c.value ORDER BY capturas DESC LIMIT 15`);
    console.table(caps.rows);

    p('¿Quién capturó declarando la ruta dominante? (top ruta por stores)');
    const topRuta = dist.rows.find((r) => r.ruta_id);
    if (topRuta) {
      const catRow = await db.raw(`SELECT * FROM catalogs WHERE id = ?`, [topRuta.ruta_id]);
      console.log('Catálogo de la ruta dominante:');
      console.table(catRow.rows);
      const who = await db.raw(`
        SELECT dc.captured_by_username,
               count(*)::int capturas,
               count(DISTINCT dc.store_id)::int tiendas,
               to_char(min(dc.created_at),'YYYY-MM-DD') primera,
               to_char(max(dc.created_at),'YYYY-MM-DD') ultima
        FROM daily_captures dc
        WHERE dc.route_id = ?
        GROUP BY dc.captured_by_username ORDER BY tiendas DESC`, [topRuta.ruta_id]);
      console.log(`Ruta dominante: ${topRuta.route_code} — ${topRuta.n} stores`);
      console.table(who.rows);
    }
    p('Recuperación SIMULADA (read-only): ruta según la captura más reciente por tienda');
    const recov = await db.raw(`
      WITH latest AS (
        SELECT DISTINCT ON (dc.store_id) dc.store_id, dc.route_id
        FROM daily_captures dc
        JOIN stores s ON s.id = dc.store_id AND s.tenant_id = dc.tenant_id
        WHERE dc.store_id IS NOT NULL AND dc.route_id IS NOT NULL AND s.deleted_at IS NULL
        ORDER BY dc.store_id, dc.hora_inicio DESC NULLS LAST, dc.created_at DESC
      )
      SELECT c.value AS route_code, count(*)::int recuperables
      FROM latest l
      JOIN catalogs c ON c.id = l.route_id AND c.catalog_id='rutas'
      GROUP BY c.value ORDER BY recuperables DESC`);
    console.table(recov.rows);
    const totalRecov = recov.rows.reduce((a, r) => a + r.recuperables, 0);
    console.log(`Recuperables desde capturas: ${totalRecov} de 285. Sin captura con ruta (quedarían sin fuente): ${285 - totalRecov}.`);

  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
