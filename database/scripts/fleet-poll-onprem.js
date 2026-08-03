/**
 * fleet-poll-onprem.js — Poller GPS MagniTracking desde la LAN (oficina) hacia
 * Railway. NECESARIO porque GPS-Server.net ata la sesión a la IP: el scraping
 * legacy devuelve 0 objetos desde el datacenter de Railway pero 49 desde la
 * oficina. Este feed reusa la MISMA lógica de LogisticsTrackingService.sync()
 * (upsert trackers + vehicle_positions + auto-match por placa) y escribe directo
 * a la DB de prod. El api de Railway sigue sirviendo el WS/live leyendo la tabla.
 *
 * Corre en la máquina de feeds (patrón 192.168.x → Railway). NO en Railway.
 *
 * ENV (nunca hardcodear credenciales):
 *   MAGNI_USER, MAGNI_PASS                     — cuenta MagniTracking
 *   MAGNI_BASE_URL   (default magnitracking.net)
 *   FLEET_DB_URL                               — Postgres de Railway (prod)
 *   MEGADULCES_TENANT_ID (default d01c)
 *   FLEET_POLL_MS    (default 60000)           — intervalo
 *   FLEET_RUN_ONCE=1                           — una sola corrida (test/cron externo)
 *
 * Uso continuo:  FLEET_DB_URL=... MAGNI_USER=... MAGNI_PASS=... node database/scripts/fleet-poll-onprem.js
 * Una corrida:   ... FLEET_RUN_ONCE=1 node database/scripts/fleet-poll-onprem.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch { /* dotenv opcional */ }
const { Client } = require('pg');

const BASE = (process.env.MAGNI_BASE_URL || 'https://magnitracking.net').replace(/\/$/, '');
const USER = process.env.MAGNI_USER || '';
const PASS = process.env.MAGNI_PASS || '';
const DB_URL = process.env.FLEET_DB_URL || process.env.RAILWAY_DB_URL || '';
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const INTERVAL = Number(process.env.FLEET_POLL_MS || 60000);
const RUN_ONCE = process.env.FLEET_RUN_ONCE === '1';

if (!USER || !PASS) { console.error('Falta MAGNI_USER / MAGNI_PASS'); process.exit(1); }
if (!DB_URL) { console.error('Falta FLEET_DB_URL (Postgres de Railway)'); process.exit(1); }

// ── Sesión MagniTracking (legacy scraping, idéntico al adapter) ───────────────
const cookies = new Map();
let loggedIn = false;
function absorb(res) {
  const gsc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of gsc) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) cookies.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
}
const cookieHeader = () => [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Cookie: cookieHeader(), Origin: BASE },
    body: new URLSearchParams(body).toString(),
  });
  absorb(res); return res;
}
async function ensureSession() {
  if (loggedIn) return;
  const seed = await fetch(`${BASE}/index.php`); absorb(seed);
  const res = await post('/api/v1/fn_connect.php', { cmd: 'login', username: USER, password: PASS, remember_me: 'false', mobile: 'false' });
  const text = await res.text();
  if (!/LOGIN_TRACKING|true/i.test(text)) throw new Error(`Login MagniTracking falló: ${text.slice(0, 120)}`);
  loggedIn = true;
}
async function loadObjectData() {
  const res = await post('/api/v1/main/fn_objects.php', { cmd: 'load_object_data' });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}
async function fetchObjects() {
  await ensureSession();
  let raw = await loadObjectData();
  if (!raw || typeof raw !== 'object') { loggedIn = false; await ensureSession(); raw = await loadObjectData(); }
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw).map(([imei, v]) => normalizeLegacy(imei, v));
}

// ── Normalización + helpers (calcados de magnitracking.adapter / service) ─────
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
function toIso(dt) {
  if (!dt || typeof dt !== 'string') return null;
  const m = dt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-06:00` : null;
}
function mapStatus(st) { return st === 'm' ? 'moving' : st === 's' ? 'stopped' : st === 'off' ? 'offline' : 'unknown'; }
function normalizeLegacy(imei, v) {
  const d = (v && v.d && v.d[0]) || [];
  const sensors = d[7] && typeof d[7] === 'object' ? d[7] : {};
  return {
    imei,
    name: (v && v.name ? String(v.name) : '').trim(),
    status: mapStatus(v && v.st),
    statusText: (v && v.ststr) || null,
    simNumber: (v && v.sim_number) || null,
    protocol: (v && v.p) || null,
    odometer: num(v && v.o),
    capturedAt: toIso(d[1]),
    lat: num(d[2]),
    lng: num(d[3]),
    altitude: num(d[4]),
    heading: num(d[5]),
    speedKmh: num(d[6]),
    ignition: sensors.acc !== undefined ? String(sensors.acc) === '1' : null,
  };
}
function parseRoute(name) { const m = (name || '').match(/R[\s-]?(\d{1,3})\b/i); return m ? `R-${m[1]}` : null; }
function normalizeRouteNumber(text) { if (!text) return null; const m = text.toUpperCase().match(/R(?:UTA)?[\s-]*0*(\d{1,3})\b/); return m ? parseInt(m[1], 10) : null; }
function matchVehicle(name, vehicles) {
  if (!name) return null;
  const tokens = new Set(name.toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 5));
  for (const v of vehicles) if (v.plate && tokens.has(String(v.plate).toUpperCase())) return v.id;
  return null;
}

// ── Un ciclo de sync (misma semántica que LogisticsTrackingService.sync) ──────
async function syncOnce(db) {
  const started = Date.now();
  const objects = await fetchObjects();
  let created = 0, updated = 0, linked = 0, positions = 0;

  const { rows: vehicles } = await db.query(
    `SELECT id, plate FROM logistics.vehicles WHERE tenant_id = $1 AND deleted_at IS NULL`, [TENANT]);

  for (const o of objects) {
    if (!o.imei) continue;
    const routeCode = parseRoute(o.name);
    const routeNumber = normalizeRouteNumber(o.name);
    const matchId = matchVehicle(o.name, vehicles);

    const { rows: ex } = await db.query(
      `SELECT id, vehicle_id, route_manual FROM logistics.trackers WHERE tenant_id = $1 AND imei = $2 LIMIT 1`,
      [TENANT, o.imei]);
    const existing = ex[0];

    let trackerId, effectiveVehicleId;
    if (existing) {
      await db.query(
        `UPDATE logistics.trackers SET
           external_name=$3, sim_number=$4, protocol=$5, route_code=$6,
           last_lat=$7, last_lng=$8, last_speed_kmh=$9, last_heading=$10, last_ignition=$11,
           last_odometer=$12, last_status=$13, last_status_text=$14, last_seen_at=$15,
           last_synced_at=now(), updated_at=now()
           ${existing.route_manual ? '' : ', route_number=$16'}
         WHERE tenant_id=$1 AND id=$2`,
        [TENANT, existing.id, o.name || null, o.simNumber, o.protocol, routeCode,
          o.lat, o.lng, o.speedKmh, o.heading, o.ignition, o.odometer, o.status, o.statusText, o.capturedAt,
          ...(existing.route_manual ? [] : [routeNumber])]);
      updated++;
      trackerId = existing.id;
      effectiveVehicleId = existing.vehicle_id || null;
      if (!effectiveVehicleId && matchId) {
        await db.query(`UPDATE logistics.trackers SET vehicle_id=$3 WHERE tenant_id=$1 AND id=$2 AND vehicle_id IS NULL`, [TENANT, existing.id, matchId]);
        effectiveVehicleId = matchId; linked++;
      }
    } else {
      const { rows: ins } = await db.query(
        `INSERT INTO logistics.trackers
           (tenant_id, provider, imei, vehicle_id, active, route_number, route_manual,
            external_name, sim_number, protocol, route_code, last_lat, last_lng, last_speed_kmh,
            last_heading, last_ignition, last_odometer, last_status, last_status_text, last_seen_at, last_synced_at, updated_at)
         VALUES ($1,'magnitracking',$2,$3,true,$4,false,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now())
         RETURNING id`,
        [TENANT, o.imei, matchId, routeNumber, o.name || null, o.simNumber, o.protocol, routeCode,
          o.lat, o.lng, o.speedKmh, o.heading, o.ignition, o.odometer, o.status, o.statusText, o.capturedAt]);
      created++;
      trackerId = ins[0].id;
      effectiveVehicleId = matchId;
      if (matchId) linked++;
    }

    if (o.lat != null && o.lng != null && o.capturedAt) {
      const r = await db.query(
        `INSERT INTO logistics.vehicle_positions
           (tenant_id, tracker_id, vehicle_id, captured_at, lat, lng, speed_kmh, heading, ignition, odometer, altitude, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id, tracker_id, captured_at) DO NOTHING`,
        [TENANT, trackerId, effectiveVehicleId, o.capturedAt, o.lat, o.lng, o.speedKmh, o.heading, o.ignition, o.odometer, o.altitude, o.status]);
      if (r.rowCount) positions++;
    }
  }
  const ms = Date.now() - started;
  console.log(`[${new Date().toISOString()}] sync: ${objects.length} objetos → ${created} nuevos, ${updated} act, ${linked} vinculados, ${positions} posiciones (${ms}ms)`);
}

// ── Loop ──────────────────────────────────────────────────────────────────────
async function cycle() {
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TENANT]);
    await syncOnce(db);
  } finally {
    await db.end();
  }
}

(async () => {
  if (RUN_ONCE) { await cycle(); return; }
  console.log(`Poller GPS on-prem → Railway cada ${INTERVAL}ms. Ctrl+C para parar.`);
  const tick = async () => { try { await cycle(); } catch (e) { console.error(`[${new Date().toISOString()}] ciclo falló: ${e.message}`); } };
  await tick();
  setInterval(tick, INTERVAL);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
