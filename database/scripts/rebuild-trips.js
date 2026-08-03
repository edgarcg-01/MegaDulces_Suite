/**
 * rebuild-trips.js — Reconstruye logistics.vehicle_stops + vehicle_day_summary de
 * un rango de días, desde logistics.vehicle_positions. Calca EXACTA de
 * TripBuilderService.buildOne (clustering 40m/5min, match cliente/tienda 90m).
 * Catch-up manual: el scanner del api solo procesa "ayer", así que días con
 * posiciones pero sin paradas (o el día en curso) se reconstruyen con esto.
 *
 * ENV: FLEET_DB_URL (o RAILWAY_DB_URL), MEGADULCES_TENANT_ID.
 * Uso:  FLEET_DB_URL=... node database/scripts/rebuild-trips.js 2026-07-27 2026-08-03
 *       (sin args → solo hoy MX)
 */
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') }); } catch {}
const { Client } = require('pg');

const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DB_URL = process.env.FLEET_DB_URL || process.env.RAILWAY_DB_URL;
const STOP_RADIUS_M = 40, STOP_MIN_MINUTES = 5, GEOFENCE_M = 90, OFFLINE_GAP_MIN = 30;

function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const bounds = (day) => ({ start: `${day}T00:00:00-06:00`, end: `${day}T23:59:59.999-06:00` });
function todayMx() { return new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10); }
function addDay(ymd) { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

async function buildOne(db, vehicleId, day, customers, stores) {
  const { start, end } = bounds(day);
  const { rows } = await db.query(
    `SELECT vp.lat, vp.lng, vp.captured_at, vp.speed_kmh
       FROM logistics.vehicle_positions vp JOIN logistics.trackers t ON t.id = vp.tracker_id
      WHERE vp.tenant_id = $1 AND t.vehicle_id = $2 AND vp.captured_at BETWEEN $3 AND $4
      ORDER BY vp.captured_at ASC`, [TENANT, vehicleId, start, end]);
  const fixes = rows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), t: new Date(r.captured_at).getTime(), speed: r.speed_kmh }))
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lng));

  const stops = []; let i = 0;
  while (i < fixes.length) {
    const anchor = fixes[i]; let j = i;
    while (j + 1 < fixes.length && haversineM(anchor.lat, anchor.lng, fixes[j + 1].lat, fixes[j + 1].lng) <= STOP_RADIUS_M) j++;
    const runMin = (fixes[j].t - anchor.t) / 60000;
    if (j > i && runMin >= STOP_MIN_MINUTES) {
      const seg = fixes.slice(i, j + 1);
      const clat = seg.reduce((a, f) => a + f.lat, 0) / seg.length;
      const clng = seg.reduce((a, f) => a + f.lng, 0) / seg.length;
      stops.push({ arrived: anchor.t, left: fixes[j].t, lat: clat, lng: clng, minutes: Math.round(runMin) });
      i = j + 1;
    } else i++;
  }
  let km = 0, offlineMin = 0, maxSpeed = 0;
  for (let k = 1; k < fixes.length; k++) {
    km += haversineM(fixes[k - 1].lat, fixes[k - 1].lng, fixes[k].lat, fixes[k].lng);
    const gap = (fixes[k].t - fixes[k - 1].t) / 60000; if (gap > OFFLINE_GAP_MIN) offlineMin += gap;
  }
  for (const f of fixes) if (Number.isFinite(f.speed) && f.speed > maxSpeed) maxSpeed = f.speed;
  const kmDriven = Math.round((km / 1000) * 100) / 100;
  const spanMin = fixes.length >= 2 ? (fixes[fixes.length - 1].t - fixes[0].t) / 60000 : 0;
  const stoppedMin = stops.reduce((a, s) => a + s.minutes, 0);
  const movingMin = Math.max(0, Math.round(spanMin - stoppedMin - offlineMin));

  const nearest = (s, pts) => { let best = null; for (const p of pts) { const d = haversineM(s.lat, s.lng, p.lat, p.lng); if (d <= GEOFENCE_M && (!best || d < best.d)) best = { id: p.id, d }; } return best; };
  const stopRows = stops.map((s) => {
    const bc = nearest(s, customers), bs = nearest(s, stores);
    return { ...s, mc: bc?.id ?? null, ms: bs?.id ?? null, md: bc ? Math.round(bc.d) : bs ? Math.round(bs.d) : null, isc: !!bc };
  });
  const customerStops = stopRows.filter((s) => s.isc).length;

  await db.query(`DELETE FROM logistics.vehicle_stops WHERE tenant_id=$1 AND vehicle_id=$2 AND arrived_at BETWEEN $3 AND $4`, [TENANT, vehicleId, start, end]);
  for (const s of stopRows) {
    await db.query(
      `INSERT INTO logistics.vehicle_stops (tenant_id, vehicle_id, arrived_at, left_at, minutes, lat, lng, matched_customer_id, matched_store_id, match_distance_m, is_customer)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [TENANT, vehicleId, new Date(s.arrived).toISOString(), new Date(s.left).toISOString(), s.minutes, s.lat, s.lng, s.mc, s.ms, s.md, s.isc]);
  }
  await db.query(
    `INSERT INTO logistics.vehicle_day_summary (tenant_id, vehicle_id, day, km_driven, moving_min, stopped_min, offline_min, stops_count, customer_stops, first_move_at, last_stop_at, max_speed_kmh, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
     ON CONFLICT (tenant_id, vehicle_id, day) DO UPDATE SET
       km_driven=EXCLUDED.km_driven, moving_min=EXCLUDED.moving_min, stopped_min=EXCLUDED.stopped_min,
       offline_min=EXCLUDED.offline_min, stops_count=EXCLUDED.stops_count, customer_stops=EXCLUDED.customer_stops,
       first_move_at=EXCLUDED.first_move_at, last_stop_at=EXCLUDED.last_stop_at, max_speed_kmh=EXCLUDED.max_speed_kmh, updated_at=now()`,
    [TENANT, vehicleId, day, kmDriven, movingMin, stoppedMin, Math.round(offlineMin), stopRows.length, customerStops,
      fixes.length ? new Date(fixes[0].t).toISOString() : null, stops.length ? new Date(stops[stops.length - 1].left).toISOString() : null, maxSpeed || null]);
  return { stops: stopRows.length, customer_stops: customerStops, km: kmDriven };
}

(async () => {
  const from = process.argv[2] || todayMx();
  const to = process.argv[3] || from;
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [TENANT]);
  const cust = (await db.query(`SELECT id, latitude, longitude FROM commercial.customers WHERE tenant_id=$1 AND latitude IS NOT NULL AND deleted_at IS NULL`, [TENANT]))
    .rows.map((r) => ({ id: r.id, lat: Number(r.latitude), lng: Number(r.longitude) })).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  const stores = (await db.query(`SELECT id, latitud, longitud FROM public.stores WHERE latitud IS NOT NULL AND deleted_at IS NULL`))
    .rows.map((r) => ({ id: r.id, lat: Number(r.latitud), lng: Number(r.longitud) })).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  console.log(`clientes geo: ${cust.length} · tiendas geo: ${stores.length}`);

  for (let day = from; day <= to; day = addDay(day)) {
    const { start, end } = bounds(day);
    const veh = (await db.query(
      `SELECT DISTINCT t.vehicle_id FROM logistics.vehicle_positions vp JOIN logistics.trackers t ON t.id=vp.tracker_id
        WHERE vp.tenant_id=$1 AND t.vehicle_id IS NOT NULL AND vp.captured_at BETWEEN $2 AND $3`, [TENANT, start, end])).rows;
    let totStops = 0;
    for (const v of veh) { const r = await buildOne(db, v.vehicle_id, day, cust, stores); totStops += r.stops; }
    console.log(`${day}: ${veh.length} vehículos → ${totStops} paradas`);
  }
  await db.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
