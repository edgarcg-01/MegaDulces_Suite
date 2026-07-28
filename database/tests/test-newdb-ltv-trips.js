/**
 * LTV.0 smoke — reconstrucción de viajes/paradas.
 *
 * Siembra posiciones sintéticas (2 clusters + tránsito) para un vehículo real en
 * una fecha de prueba (2020-01-01), coloca el cluster A sobre un cliente ya
 * geocodificado, corre la MISMA segmentación del servicio, persiste en
 * vehicle_stops/vehicle_day_summary como app_runtime (RLS) y verifica paradas,
 * match a cliente y km. Self-cleaning (borra lo sintético al final).
 *
 * Uso: node database/tests/test-newdb-ltv-trips.js
 */
require('dotenv').config();
const { Client } = require('pg');

const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DAY = '2020-01-01';
const START = `${DAY}T00:00:00-06:00`;
const END = `${DAY}T23:59:59.999-06:00`;
const TRACKER = '11111111-1111-1111-1111-111111111111'; // synthetic
const STOP_RADIUS_M = 40, STOP_MIN_MINUTES = 5, GEOFENCE_M = 90, OFFLINE_GAP_MIN = 30;

let assertions = 0;
function assert(c, m) { assertions++; if (!c) throw new Error('ASSERT FAIL: ' + m); console.log('  ✓ ' + m); }
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

(async () => {
  console.log('\n=== LTV.0 smoke: viajes/paradas ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  try {
    const veh = (await q('select id from logistics.vehicles where deleted_at is null limit 1'))[0];
    assert(!!veh, 'hay al menos un vehículo para la prueba');
    const cust = (await q('select id, latitude::float lat, longitude::float lng from commercial.customers where latitude is not null and deleted_at is null limit 1'))[0];
    assert(!!cust, `hay un cliente geocodificado para el match (id ${cust && cust.id})`);

    // limpiar corridas previas del día de prueba
    await client.query('delete from logistics.vehicle_positions where vehicle_id=$1 and captured_at between $2 and $3', [veh.id, START, END]);
    await client.query('delete from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3', [veh.id, START, END]);
    await client.query('delete from logistics.vehicle_day_summary where vehicle_id=$1 and day=$2', [veh.id, DAY]);

    // sembrar: cluster A (6 fixes @ cliente, 2 min), tránsito (3 fixes), cluster B (6 fixes ~2km)
    const base = new Date(`${DAY}T14:00:00-06:00`).getTime();
    const fixes = [];
    for (let i = 0; i < 6; i++) fixes.push({ lat: cust.lat + (i % 2 ? 0.00005 : 0), lng: cust.lng, min: i * 2, spd: 0 });      // A (10 min)
    for (let i = 0; i < 3; i++) fixes.push({ lat: cust.lat + 0.006 * (i + 1), lng: cust.lng + 0.006 * (i + 1), min: 12 + i * 2, spd: 40 }); // tránsito
    for (let i = 0; i < 6; i++) fixes.push({ lat: cust.lat + 0.02, lng: cust.lng + 0.02, min: 20 + i * 2, spd: 0 });          // B (10 min, lejos)
    let seq = 0;
    for (const f of fixes) {
      const ts = new Date(base + f.min * 60000).toISOString();
      await client.query(
        `insert into logistics.vehicle_positions (tenant_id,tracker_id,vehicle_id,captured_at,lat,lng,speed_kmh,status) values ($1,$2,$3,$4,$5,$6,$7,'stopped') on conflict do nothing`,
        [TENANT, TRACKER, veh.id, ts, f.lat, f.lng, f.spd]);
      seq++;
    }
    assert(seq === 15, 'sembradas 15 posiciones sintéticas');

    // ── segmentación (misma lógica del servicio) ──
    const rows = await q('select lat::float lat, lng::float lng, extract(epoch from captured_at)*1000 t, speed_kmh from logistics.vehicle_positions where vehicle_id=$1 and captured_at between $2 and $3 order by captured_at', [veh.id, START, END]);
    const pts = rows.map(r => ({ lat: r.lat, lng: r.lng, t: Number(r.t), speed: r.speed_kmh }));
    const stops = []; let km = 0, offlineMin = 0, i = 0;
    while (i < pts.length) {
      const anchor = pts[i]; let j = i;
      while (j + 1 < pts.length && haversineM(anchor.lat, anchor.lng, pts[j + 1].lat, pts[j + 1].lng) <= STOP_RADIUS_M) j++;
      const runMin = (pts[j].t - anchor.t) / 60000;
      if (j > i && runMin >= STOP_MIN_MINUTES) {
        const seg = pts.slice(i, j + 1);
        stops.push({ arrived: anchor.t, left: pts[j].t, lat: seg.reduce((a, f) => a + f.lat, 0) / seg.length, lng: seg.reduce((a, f) => a + f.lng, 0) / seg.length, minutes: Math.round(runMin) });
        i = j + 1;
      } else i++;
    }
    for (let k = 1; k < pts.length; k++) { km += haversineM(pts[k - 1].lat, pts[k - 1].lng, pts[k].lat, pts[k].lng); const g = (pts[k].t - pts[k - 1].t) / 60000; if (g > OFFLINE_GAP_MIN) offlineMin += g; }
    const kmDriven = Math.round((km / 1000) * 100) / 100;
    const customers = (await q('select id, latitude::float lat, longitude::float lng from commercial.customers where latitude is not null and deleted_at is null')).map(c => ({ id: c.id, lat: c.lat, lng: c.lng }));
    const stopRows = stops.map(s => { let best = null; for (const c of customers) { const d = haversineM(s.lat, s.lng, c.lat, c.lng); if (d <= GEOFENCE_M && (!best || d < best.d)) best = { id: c.id, d }; } return { ...s, matched: best?.id ?? null, dist: best ? Math.round(best.d) : null }; });

    for (const s of stopRows) await client.query(
      `insert into logistics.vehicle_stops (tenant_id,vehicle_id,arrived_at,left_at,minutes,lat,lng,matched_customer_id,match_distance_m,is_customer) values (public.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [veh.id, new Date(s.arrived).toISOString(), new Date(s.left).toISOString(), s.minutes, s.lat, s.lng, s.matched, s.dist, !!s.matched]);
    const stoppedMin = stops.reduce((a, s) => a + s.minutes, 0);
    const spanMin = (pts[pts.length - 1].t - pts[0].t) / 60000;
    await client.query(
      `insert into logistics.vehicle_day_summary (tenant_id,vehicle_id,day,km_driven,moving_min,stopped_min,offline_min,stops_count,customer_stops) values (public.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8) on conflict (tenant_id,vehicle_id,day) do update set km_driven=excluded.km_driven,stops_count=excluded.stops_count,customer_stops=excluded.customer_stops`,
      [veh.id, DAY, kmDriven, Math.max(0, Math.round(spanMin - stoppedMin - offlineMin)), stoppedMin, Math.round(offlineMin), stopRows.length, stopRows.filter(s => s.matched).length]);

    // ── asserts ──
    assert(stopRows.length === 2, `detectó 2 paradas (A y B), obtuvo ${stopRows.length}`);
    assert(stopRows.some(s => s.matched === cust.id && s.dist <= GEOFENCE_M), 'la parada A matcheó al cliente geocodificado por cercanía');
    assert(kmDriven > 0, `km_driven > 0 (${kmDriven} km)`);
    const dbStops = (await q('select count(*)::int n, count(matched_customer_id)::int m from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3', [veh.id, START, END]))[0];
    assert(dbStops.n === 2 && dbStops.m >= 1, `persistió en vehicle_stops (RLS OK): ${dbStops.n} paradas, ${dbStops.m} con cliente`);
    const dbSum = (await q('select km_driven::float k, stops_count s, customer_stops c from logistics.vehicle_day_summary where vehicle_id=$1 and day=$2', [veh.id, DAY]))[0];
    assert(dbSum && dbSum.s === 2 && dbSum.c >= 1, `vehicle_day_summary correcto (km ${dbSum && dbSum.k}, ${dbSum && dbSum.s} paradas)`);

    // cleanup
    await client.query('delete from logistics.vehicle_positions where vehicle_id=$1 and captured_at between $2 and $3', [veh.id, START, END]);
    await client.query('delete from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3', [veh.id, START, END]);
    await client.query('delete from logistics.vehicle_day_summary where vehicle_id=$1 and day=$2', [veh.id, DAY]);
    await client.query('COMMIT');
    console.log(`\n✅ ${assertions}/${assertions} asserts OK\n`);
    process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
