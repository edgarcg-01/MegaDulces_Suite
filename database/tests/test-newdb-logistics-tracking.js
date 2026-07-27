/**
 * LT.0/LT.1 smoke — rastreo de flota (MagniTracking → logistics.trackers/positions).
 *
 * Corre como app_runtime con RLS (SET app.tenant_id) para validar el contrato
 * real: migraciones, grants, RLS, auto-match por placa e idempotencia del sync.
 *
 * Requiere en el entorno: MAGNI_USER, MAGNI_PASS (credenciales del proveedor) y
 * DATABASE_URL_NEW_RUNTIME (conexión app_runtime a la DB nueva).
 *
 * Uso: MAGNI_USER=... MAGNI_PASS=... node database/tests/test-newdb-logistics-tracking.js
 */
require('dotenv').config();
const { Client } = require('pg');

const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const BASE = (process.env.MAGNI_BASE_URL || 'https://magnitracking.net').replace(/\/$/, '');
const USER = process.env.MAGNI_USER;
const PASS = process.env.MAGNI_PASS;

let assertions = 0;
function assert(cond, msg) {
  assertions++;
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}

// ── provider (replica del adapter) ───────────────────────────────────────────
const cookies = new Map();
function absorb(res) {
  const cs = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of cs) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) cookies.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
async function post(path, body) {
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', Cookie: cookieHeader(), Origin: BASE }, body: new URLSearchParams(body).toString() });
  absorb(res); return res;
}
const mapStatus = (s) => ({ m: 'moving', s: 'stopped', off: 'offline' }[s] || 'unknown');
const toIso = (dt) => { const m = (dt || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-06:00` : null; };
const parseRoute = (n) => { const m = (n || '').match(/R[\s-]?(\d{1,3})\b/i); return m ? `R-${m[1]}` : null; };
const KNOWN_BRANDS = ['NISSAN', 'CHEVROLET', 'FORD', 'RAM', 'DODGE', 'TOYOTA', 'HONDA', 'VOLKSWAGEN', 'VW', 'AVANZA', 'ITALIKA', 'TRANSIT', 'SUBURBAN', 'SAVEIRO', 'JEEP', 'MAZDA', 'HINO', 'ISUZU', 'INTERNATIONAL', 'FREIGHTLINER', 'KENWORTH'];
function extractPlate(name) {
  if (!name) return null;
  const toks = name.toUpperCase().replace(/\([^)]*\)/g, ' ').split(/[^A-Z0-9]+/).filter(Boolean);
  const cands = toks.filter((t) => t.length >= 5 && t.length <= 8 && /[A-Z]/.test(t) && /\d/.test(t) && !/^R\d+$/.test(t));
  return cands.length ? cands[cands.length - 1] : null;
}
function extractBrand(name) {
  if (!name) return null;
  const toks = name.toUpperCase().replace(/\([^)]*\)/g, ' ').split(/[^A-Z0-9]+/).filter(Boolean);
  return toks.find((t) => KNOWN_BRANDS.includes(t)) || toks[0] || null;
}
async function bootstrap(client) {
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  const trackers = (await client.query('select id, external_name from logistics.trackers where deleted_at is null and vehicle_id is null')).rows;
  let created = 0, linked = 0, skipped = 0;
  for (const t of trackers) {
    const plate = extractPlate(t.external_name);
    if (!plate) { skipped++; continue; }
    let veh = (await client.query('select id from logistics.vehicles where plate=$1 and deleted_at is null', [plate])).rows[0];
    if (!veh) { veh = (await client.query("insert into logistics.vehicles (tenant_id,plate,brand,status,active,notes) values (public.current_tenant_id(),$1,$2,'disponible',true,$3) returning id", [plate, extractBrand(t.external_name), `Auto-creado desde rastreo GPS: ${t.external_name}`])).rows[0]; created++; }
    await client.query('update logistics.trackers set vehicle_id=$2, updated_at=now() where id=$1', [t.id, veh.id]);
    linked++;
  }
  await client.query('COMMIT');
  return { created, linked, skipped };
}
function matchVehicle(name, vehicles) {
  const toks = new Set((name || '').toUpperCase().split(/[^A-Z0-9]+/).filter((t) => t.length >= 5));
  for (const v of vehicles) if (v.plate && toks.has(v.plate.toUpperCase())) return v.id;
  return null;
}
async function fetchObjects() {
  await fetch(`${BASE}/index.php`).then(absorb);
  const lg = await (await post('/api/v1/fn_connect.php', { cmd: 'login', username: USER, password: PASS, remember_me: 'false', mobile: 'false' })).text();
  if (!/LOGIN_TRACKING|true/i.test(lg)) throw new Error('login falló: ' + lg.slice(0, 80));
  const raw = JSON.parse(await (await post('/api/v1/main/fn_objects.php', { cmd: 'load_object_data' })).text());
  return Object.entries(raw).map(([imei, v]) => {
    const d = (v.d && v.d[0]) || {}; const s = d[7] && typeof d[7] === 'object' ? d[7] : {};
    return { imei, name: (v.name || '').trim(), status: mapStatus(v.st), statusText: v.ststr, simNumber: v.sim_number, protocol: v.p, odometer: Number(v.o) || null, capturedAt: toIso(d[1]), lat: Number(d[2]) || null, lng: Number(d[3]) || null, altitude: Number(d[4]) || null, heading: Number(d[5]) || null, speedKmh: Number(d[6]) || null, ignition: s.acc !== undefined ? String(s.acc) === '1' : null };
  });
}

// ── sync (replica del service) ───────────────────────────────────────────────
async function sync(client, objects) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  const vehicles = (await client.query('select id, plate from logistics.vehicles where deleted_at is null')).rows;
  let created = 0, updated = 0, linked = 0, positions = 0;
  for (const o of objects) {
    if (!o.imei) continue;
    const routeCode = parseRoute(o.name);
    const matchId = matchVehicle(o.name, vehicles);
    const last = [o.name || null, o.simNumber || null, o.protocol || null, routeCode, o.lat, o.lng, o.speedKmh, o.heading, o.ignition, o.odometer, o.status, o.statusText || null, o.capturedAt];
    const ex = (await client.query('select id, vehicle_id from logistics.trackers where imei=$1', [o.imei])).rows[0];
    let trackerId, effVeh;
    if (ex) {
      await client.query(`update logistics.trackers set external_name=$2,sim_number=$3,protocol=$4,route_code=$5,last_lat=$6,last_lng=$7,last_speed_kmh=$8,last_heading=$9,last_ignition=$10,last_odometer=$11,last_status=$12,last_status_text=$13,last_seen_at=$14,last_synced_at=now(),updated_at=now() where id=$1`, [ex.id, ...last]);
      updated++; trackerId = ex.id; effVeh = ex.vehicle_id || null;
      if (!effVeh && matchId) { await client.query('update logistics.trackers set vehicle_id=$2 where id=$1 and vehicle_id is null', [ex.id, matchId]); effVeh = matchId; linked++; }
    } else {
      const r = (await client.query(`insert into logistics.trackers (tenant_id,provider,imei,vehicle_id,active,external_name,sim_number,protocol,route_code,last_lat,last_lng,last_speed_kmh,last_heading,last_ignition,last_odometer,last_status,last_status_text,last_seen_at,last_synced_at,updated_at) values (public.current_tenant_id(),'magnitracking',$1,$2,true,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),now()) returning id`, [o.imei, matchId, ...last])).rows[0];
      created++; trackerId = r.id; effVeh = matchId; if (matchId) linked++;
    }
    if (o.lat != null && o.lng != null && o.capturedAt) {
      const ins = await client.query(`insert into logistics.vehicle_positions (tenant_id,tracker_id,vehicle_id,captured_at,lat,lng,speed_kmh,heading,ignition,odometer,altitude,status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tenant_id,tracker_id,captured_at) do nothing`, [TENANT, trackerId, effVeh, o.capturedAt, o.lat, o.lng, o.speedKmh, o.heading, o.ignition, o.odometer, o.altitude, o.status]);
      positions += ins.rowCount;
    }
  }
  await client.query('COMMIT');
  return { objects: objects.length, created, updated, linked, positions };
}

async function scanAlerts(client) {
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  const trackers = (await client.query('select id, vehicle_id, last_seen_at, last_speed_kmh from logistics.trackers where deleted_at is null')).rows;
  const now = Date.now(); let opened = 0, resolved = 0;
  for (const t of trackers) {
    const mins = t.last_seen_at ? Math.floor((now - new Date(t.last_seen_at).getTime()) / 60000) : null;
    const conds = [
      { kind: 'offline', on: mins != null && mins >= 90 && mins <= 1440, sev: 'danger', val: mins ?? 0, msg: `Sin señal hace ${mins} min` },
      { kind: 'speed', on: (t.last_speed_kmh ?? 0) >= 90, sev: 'warn', val: t.last_speed_kmh ?? 0, msg: `Exceso de velocidad: ${t.last_speed_kmh} km/h` },
    ];
    for (const c of conds) {
      const open = (await client.query("select id from logistics.fleet_alerts where tracker_id=$1 and kind=$2 and status='open'", [t.id, c.kind])).rows[0];
      if (c.on) {
        if (open) await client.query('update logistics.fleet_alerts set last_seen_at=now(), value=$2, message=$3, severity=$4 where id=$1', [open.id, c.val, c.msg, c.sev]);
        else { await client.query("insert into logistics.fleet_alerts (tenant_id,tracker_id,vehicle_id,kind,severity,message,value,status) values (public.current_tenant_id(),$1,$2,$3,$4,$5,$6,'open')", [t.id, t.vehicle_id, c.kind, c.sev, c.msg, c.val]); opened++; }
      } else if (open) { await client.query("update logistics.fleet_alerts set status='resolved', resolved_at=now() where id=$1", [open.id]); resolved++; }
    }
  }
  await client.query('COMMIT');
  return { opened, resolved, scanned: trackers.length };
}

(async () => {
  console.log('\n=== LT smoke: rastreo de flota ===');
  if (!USER || !PASS) throw new Error('Faltan MAGNI_USER / MAGNI_PASS');
  const conn = process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW;
  const client = new Client({ connectionString: conn });
  await client.connect();
  try {
    const objects = await fetchObjects();
    assert(objects.length > 0, `proveedor devolvió ${objects.length} objetos`);

    const r1 = await sync(client, objects);
    console.log('  sync #1:', JSON.stringify(r1));
    assert(r1.created + r1.updated === objects.length, 'todos los objetos upserted como trackers');
    console.log(`  auto-match (delta esta corrida): ${r1.linked}`);

    await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
    const tc = (await client.query('select count(*)::int n from logistics.trackers')).rows[0].n;
    const rc = (await client.query("select count(*)::int n from logistics.trackers where route_code is not null")).rows[0].n;
    const pc = (await client.query('select count(*)::int n from logistics.vehicle_positions where tenant_id=$1', [TENANT])).rows[0].n;
    await client.query('COMMIT');
    assert(tc === objects.length, `logistics.trackers tiene ${tc} filas (RLS OK como app_runtime)`);
    assert(rc > 0, `${rc} trackers con route_code parseado (R-NN)`);
    assert(pc > 0, `logistics.vehicle_positions tiene ${pc} posiciones`);

    const r2 = await sync(client, objects);
    console.log('  sync #2:', JSON.stringify(r2));
    assert(r2.created === 0, 'sync idempotente: 0 trackers nuevos en 2da corrida');
    assert(r2.positions <= r1.positions, 'dedupe de posiciones: 2da corrida no re-inserta el mismo fix');

    const b1 = await bootstrap(client);
    console.log('  bootstrap:', JSON.stringify(b1));
    const withPlate = objects.filter((o) => extractPlate(o.name)).length;

    await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
    const linkedNow = (await client.query('select count(*)::int n from logistics.trackers where vehicle_id is not null')).rows[0].n;
    await client.query('COMMIT');
    assert(withPlate > objects.length / 2, `${withPlate}/${objects.length} trackers con placa parseable`);
    assert(linkedNow === withPlate, `todos los trackers con placa quedaron vinculados (${linkedNow}/${withPlate})`);

    const b2 = await bootstrap(client);
    assert(b2.created === 0 && b2.linked === 0, 'bootstrap idempotente: 2da corrida no crea ni vincula');

    // ── Alertas (LT.6) ──
    const s1 = await scanAlerts(client);
    console.log('  scan alertas:', JSON.stringify(s1));
    assert(s1.scanned === objects.length, `scanner recorrió los ${s1.scanned} trackers`);
    const s2 = await scanAlerts(client);
    assert(s2.opened === 0, 'scanner idempotente: 0 alertas nuevas en 2da corrida');

    await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
    const exp = (await client.query("select ((select count(*) from logistics.trackers where deleted_at is null and last_speed_kmh>=90) + (select count(*) from logistics.trackers where deleted_at is null and last_seen_at is not null and extract(epoch from (now()-last_seen_at))/60 between 90 and 1440))::int n")).rows[0].n;
    const act = (await client.query("select count(*)::int n from logistics.fleet_alerts where status in ('open','ack')")).rows[0].n;
    await client.query('COMMIT');
    assert(act === exp, `alertas activas (${act}) == condiciones detectadas (${exp})`);

    console.log(`\n✅ ${assertions}/${assertions} asserts OK\n`);
    process.exit(0);
  } catch (e) {
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally {
    await client.end();
  }
})();
