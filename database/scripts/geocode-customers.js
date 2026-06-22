/**
 * J12 — Geocodifica clientes (commercial.customers): billing_address → lat/lng.
 * Enciende los checks de geolocalización / ruteo / ETA del módulo logística.
 *
 *   node geocode-customers.js                 # dry-run (geocodifica muestra, NO escribe)
 *   node geocode-customers.js --apply         # escribe lat/lng
 *   node geocode-customers.js --limit 100     # acota cuántos procesa (default 25)
 *
 * Geocoder: Nominatim (OpenStreetMap), gratis, sin key. Throttle 1.1s/req por su
 * política de uso. Para volumen grande / producción continua, considerar un
 * geocoder pago (Google/Mapbox) o capturar GPS en la visita del vendedor.
 *
 * Idempotente: solo clientes con billing_address y lat/lng NULL. Dry-run default.
 * Conexión: DATABASE_URL_NEW (.env) o local. Tenant: mega_dulces.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 25;
const CONN = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.CP_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const UA = 'MegaDulces-Logistics-Geocoder/1.0';

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
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=mx&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'es' } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => []);
  if (!data?.length) return null;
  return { lat: Number(data[0].lat), lng: Number(data[0].lon) };
}

(async () => {
  const knex = knexLib({ client: 'pg', connection: CONN, pool: { min: 1, max: 2 } });
  console.log(`\n${APPLY ? '⚙️  APLICANDO' : '🔎 DRY-RUN'} · tenant ${TENANT} · límite ${LIMIT}\n`);

  const [{ pend }] = (
    await knex.raw(
      `SELECT count(*)::int pend FROM commercial.customers
        WHERE tenant_id=? AND deleted_at IS NULL AND (latitude IS NULL OR longitude IS NULL)
          AND billing_address IS NOT NULL AND billing_address::text <> '{}'`, [TENANT])
  ).rows;
  console.log(`Clientes con dirección y sin coords: ${pend}\n`);

  const rows = await knex('commercial.customers')
    .where({ tenant_id: TENANT })
    .whereNull('deleted_at')
    .where(function () { this.whereNull('latitude').orWhereNull('longitude'); })
    .whereNotNull('billing_address')
    .whereRaw(`billing_address::text <> '{}'`)
    .select('id', 'code', 'name', 'billing_address')
    .limit(LIMIT);

  let ok = 0, fail = 0;
  for (const c of rows) {
    const addr = typeof c.billing_address === 'string' ? JSON.parse(c.billing_address) : c.billing_address;
    const q = buildQuery(addr);
    if (!q) { console.log(`  ✗ ${c.code} ${c.name} — dirección vacía`); fail++; continue; }
    let geo = null;
    try { geo = await geocode(q); } catch (e) { /* red */ }
    await sleep(1100); // política Nominatim
    if (!geo) { console.log(`  ✗ ${c.code} ${c.name} — sin match: "${q}"`); fail++; continue; }
    console.log(`  ✓ ${c.code} ${c.name} → ${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`);
    if (APPLY) {
      await knex('commercial.customers').where({ id: c.id })
        .update({ latitude: geo.lat, longitude: geo.lng, updated_at: knex.fn.now() });
    }
    ok++;
  }

  console.log(`\n${APPLY ? '✅ Escritos' : 'Encontrados (dry-run)'}: ${ok} · sin match: ${fail} · restantes: ${Math.max(0, pend - rows.length)}`);
  if (!APPLY) console.log('Dry-run: nada escrito. Usá --apply para guardar.');
  await knex.destroy();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
