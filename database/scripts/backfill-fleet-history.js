/**
 * Backfill de "información anterior" de la flota (LT.8b).
 *
 * Le pide a MagniTracking (API oficial history.php) el histórico de recorrido de
 * TODOS los dispositivos en un rango de días y lo vuelca a
 * logistics.vehicle_positions (idempotente por el índice único
 * tenant_id+tracker_id+captured_at). Resuelve el tracker por IMEI y solo inserta
 * fixes de trackers ya registrados (corré el sync antes si faltan).
 *
 * Usa su PROPIA conexión pg (NO el transaction interceptor de la API) → inmune al
 * 25P02 de tx-por-request y sin lock global.
 *
 * Requiere env (nunca hardcodear):
 *   MAGNI_BASE_URL (default https://magnitracking.net), MAGNI_API_CLIENT_ID,
 *   MAGNI_USER, MAGNI_PASS, y la conexión DB (DATABASE_URL_NEW o DATABASE_URL).
 *
 * Uso:
 *   node database/scripts/backfill-fleet-history.js 2026-07-24 2026-07-31
 *   node database/scripts/backfill-fleet-history.js            # últimos 7 días
 */
require('dotenv').config();
const { Client } = require('pg');

const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const BASE = (process.env.MAGNI_BASE_URL || 'https://magnitracking.net').replace(/\/$/, '');
const CLIENT_ID = process.env.MAGNI_API_CLIENT_ID || '';
const USER = process.env.MAGNI_USER || '';
const PASS = process.env.MAGNI_PASS || '';

const ymd = (d) => d.toISOString().slice(0, 10);
const addDay = (s) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return ymd(d); };
// dt_tracker "YYYY-MM-DD HH:mm:ss" (hora local MX, sin DST desde 2022) → ISO -06:00.
const toIso = (dt) => {
  const m = String(dt || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-06:00` : null;
};
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

async function getToken() {
  const res = await fetch(`${BASE}/api/v1/endpoints/auth.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: CLIENT_ID, username: USER, password: PASS }).toString(),
  });
  const json = await res.json().catch(() => null);
  const token = json?.data?.access_token || json?.access_token;
  if (!token) throw new Error(`Auth MagniTracking falló: ${JSON.stringify(json).slice(0, 160)}`);
  return token;
}

async function fetchHistory(token, from, to) {
  const qs = new URLSearchParams({ imei: '*', from, to, sensors: 'false' }).toString();
  const res = await fetch(`${BASE}/api/v1/endpoints/history.php?${qs}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const json = await res.json().catch(() => null);
  return Array.isArray(json?.data) ? json.data : [];
}

(async () => {
  if (!CLIENT_ID || !USER || !PASS) {
    console.error('❌ Faltan credenciales MAGNI_API_CLIENT_ID / MAGNI_USER / MAGNI_PASS en env.');
    process.exit(1);
  }
  // Rango: args o últimos 7 días (MX).
  const todayMx = ymd(new Date(Date.now() - 6 * 3600 * 1000));
  const from = process.argv[2] || (() => { const d = new Date(`${todayMx}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 7); return ymd(d); })();
  const to = process.argv[3] || todayMx;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    console.error('❌ Rango inválido. Uso: node backfill-fleet-history.js <from YYYY-MM-DD> <to YYYY-MM-DD>');
    process.exit(1);
  }

  const conn = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  const client = new Client({ connectionString: conn });
  await client.connect();

  console.log(`\n=== Backfill flota ${from}..${to} (tenant ${TENANT.slice(0, 8)}) ===`);
  const { rows: trackers } = await client.query(
    `select id, imei, vehicle_id from logistics.trackers where tenant_id=$1 and deleted_at is null and imei is not null`,
    [TENANT],
  );
  const byImei = new Map(trackers.map((t) => [t.imei, { tracker_id: t.id, vehicle_id: t.vehicle_id }]));
  console.log(`Trackers registrados: ${byImei.size}`);
  if (!byImei.size) { console.error('❌ No hay trackers. Corré el sync primero.'); await client.end(); process.exit(1); }

  const token = await getToken();
  console.log('Token obtenido.');

  let fetched = 0, inserted = 0;
  for (let day = from; day <= to; day = addDay(day)) {
    const raw = await fetchHistory(token, `${day} 00:00:00`, `${day} 23:59:59`);
    fetched += raw.length;
    const rows = [];
    for (const r of raw) {
      const iso = toIso(r?.dt_tracker), lat = num(r?.lat), lng = num(r?.lng);
      const t = byImei.get(String(r?.imei ?? '').trim());
      if (!iso || lat == null || lng == null || !t) continue;
      rows.push({ ...t, iso, lat, lng, speed: num(r?.speed), angle: num(r?.angle), alt: num(r?.altitude), odo: num(r?.odometer) });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = [];
      const params = [];
      chunk.forEach((p, k) => {
        const b = k * 10;
        vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`);
        params.push(TENANT, p.tracker_id, p.vehicle_id, p.iso, p.lat, p.lng, p.speed, p.angle, p.odo, p.alt);
      });
      const res = await client.query(
        `insert into logistics.vehicle_positions (tenant_id,tracker_id,vehicle_id,captured_at,lat,lng,speed_kmh,heading,odometer,altitude)
         values ${vals.join(',')}
         on conflict (tenant_id,tracker_id,captured_at) do nothing`,
        params,
      );
      inserted += res.rowCount || 0;
    }
    console.log(`  ${day}: ${raw.length} fixes → ${inserted} insertados (acum)`);
  }

  console.log(`\n✅ Backfill: ${fetched} fixes traídos, ${inserted} insertados (dedupe idempotente).`);
  await client.end();
  process.exit(0);
})().catch((e) => { console.error('\n❌', e.message, '\n'); process.exit(1); });
