/**
 * Geocodifica commercial.customers (billing_address → lat/lng) con MAPBOX.
 * Mejor calidad que Nominatim en MX + score de `relevance` para descartar
 * matches dudosos (coords malas rompen geofence/cobertura/matching).
 *
 *   node geocode-mapbox.js                 # dry-run (NO escribe)
 *   node geocode-mapbox.js --apply         # escribe latitude/longitude
 *   node geocode-mapbox.js --limit 200     # cuántos procesa (default 50)
 *   node geocode-mapbox.js --min 0.6       # relevancia mínima (default 0.5)
 *
 * Idempotente: solo customers con billing_address y latitude/longitude NULL.
 * Requiere MAPBOX_TOKEN en .env. Conexión: DATABASE_URL_NEW o local. Tenant MD.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? Number(process.argv[i + 1]) : d; };
const LIMIT = arg('--limit', 50);
const MIN_REL = arg('--min', 0.5);
const TOKEN = process.env.MAPBOX_TOKEN;
const CONN = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.CP_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
// Sesgo geográfico (centro de operación) para mejorar la relevancia.
const PROXIMITY = process.env.GEO_PROXIMITY || '-101.1949,19.7033'; // Morelia

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildQuery(a) {
  if (!a || typeof a !== 'object') return null;
  const parts = [
    [a.street, a.exterior_number].filter(Boolean).join(' '),
    a.neighborhood, a.city, a.state, a.zip,
  ].filter(Boolean);
  if (!parts.length) return null;
  return parts.join(', ') + ', México';
}

async function geocode(q) {
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json` +
    `?access_token=${TOKEN}&country=mx&limit=1&language=es&proximity=${PROXIMITY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const f = data?.features?.[0];
  if (!f?.center?.length) return null;
  return { lng: Number(f.center[0]), lat: Number(f.center[1]), relevance: Number(f.relevance), place: f.place_name };
}

(async () => {
  if (!TOKEN) { console.error('falta MAPBOX_TOKEN en .env'); process.exit(1); }
  const db = knexLib({ client: 'pg', connection: { connectionString: CONN, ssl: CONN.includes('localhost') ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } });
  let ok = 0, low = 0, fail = 0, skip = 0;
  try {
    const rows = await db('commercial.customers')
      .where('tenant_id', TENANT)
      .whereNull('latitude')
      .whereNotNull('billing_address')
      .select('id', 'name', 'billing_address')
      .limit(LIMIT);
    console.log(`Modo: ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN'} · candidatos: ${rows.length} · min relevancia: ${MIN_REL}\n`);

    for (const r of rows) {
      const q = buildQuery(r.billing_address);
      if (!q) { skip++; continue; }
      const g = await geocode(q);
      await sleep(120); // ~500 req/min, dentro del límite de Mapbox
      if (!g) { fail++; console.log(`  ✗ ${r.name}: sin resultado`); continue; }
      if (g.relevance < MIN_REL) { low++; console.log(`  ~ ${r.name}: relevancia ${g.relevance.toFixed(2)} < ${MIN_REL} (descartado) → ${g.place}`); continue; }
      ok++;
      console.log(`  ✓ ${r.name}: ${g.lat.toFixed(5)},${g.lng.toFixed(5)} (rel ${g.relevance.toFixed(2)})`);
      if (APPLY) await db('commercial.customers').where('id', r.id).update({ latitude: g.lat, longitude: g.lng });
    }
    console.log(`\nResumen: ${ok} geocodificados${APPLY ? ' (escritos)' : ' (dry-run)'} · ${low} relevancia baja · ${fail} sin resultado · ${skip} sin dirección`);
  } catch (e) { console.error('ERROR:', e.message); process.exitCode = 1; }
  finally { await db.destroy(); }
})();
