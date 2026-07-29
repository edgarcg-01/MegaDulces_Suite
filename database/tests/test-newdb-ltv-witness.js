/**
 * LTV.13 smoke — Horus doble testigo (vehicle-witness-audit).
 *
 * Verifica el detector `vehicle_stop_no_capture`: una unidad de ruta se detiene
 * en una tienda ≥5 min pero NO hubo captura de auditoría cerca → debe aparecer
 * como hallazgo por tienda. Y valida que la query de `capture_no_vehicle_presence`
 * corre y agrega bien (SQL pesado con haversine). Todo en tx con ROLLBACK.
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DAY = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const HAV = `2 * 6371000 * asin(sqrt(power(sin(radians(dc.latitud::float8 - st.lat::float8)/2),2) + cos(radians(st.lat::float8))*cos(radians(dc.latitud::float8))*power(sin(radians(dc.longitud::float8 - st.lng::float8)/2),2)))`;

let n = 0; const assert = (c, m) => { n++; if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  console.log('\n=== LTV.13 smoke: Horus doble testigo ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  try {
    const stores = await q(`select id, latitud, longitud from public.stores where latitud is not null and longitud is not null and deleted_at is null limit 2`);
    assert(stores.length === 2, `2 tiendas geolocalizadas para el test (obtuvo ${stores.length})`);
    const [sA, sB] = stores;

    const veh = (await q(`insert into logistics.vehicles (tenant_id,plate,status,active) values (public.current_tenant_id(),'LTVWIT-PLATE','disponible',true) returning id`))[0];
    await client.query(`insert into logistics.trackers (tenant_id,provider,imei,vehicle_id,active,route_number,route_manual) values (public.current_tenant_id(),'magnitracking','LTVWIT-IMEI',$1,true,88,true)`, [veh.id]);

    const mkStop = async (store, h) => client.query(
      `insert into logistics.vehicle_stops (tenant_id,vehicle_id,arrived_at,left_at,minutes,lat,lng,matched_store_id,is_customer) values (public.current_tenant_id(),$1,$2,$3,10,$4,$5,$6,false)`,
      [veh.id, `${DAY}T${h}:00:00-06:00`, `${DAY}T${h}:10:00-06:00`, store.latitud, store.longitud, store.id]);
    await mkStop(sA, '09'); await mkStop(sB, '10');

    // ── Hallazgo 1: paradas en tienda de unidad de ruta SIN captura ──
    const flagged = await q(`
      select st.matched_store_id store_id, count(*)::int stop_events, sum(st.minutes)::int minutes_total
      from logistics.vehicle_stops st
      where st.tenant_id = public.current_tenant_id()
        and st.matched_store_id is not null
        and st.arrived_at >= now() - interval '30 days'
        and st.minutes >= 5
        and exists (select 1 from logistics.trackers tr where tr.vehicle_id=st.vehicle_id and tr.route_number is not null)
        and not exists (
          select 1 from public.daily_captures dc where dc.tenant_id=st.tenant_id
            and dc.hora_inicio between st.arrived_at - interval '10 minutes' and st.left_at + interval '10 minutes'
            and dc.latitud is not null and dc.longitud is not null and ${HAV} <= 150)
      group by st.matched_store_id`);
    const byStore = new Map(flagged.map(r => [r.store_id, r]));
    assert(byStore.has(sA.id) && byStore.has(sB.id), 'ambas tiendas (A y B) marcadas como parada-sin-captura');
    assert(byStore.get(sA.id).stop_events >= 1 && byStore.get(sA.id).minutes_total >= 10, 'evidencia con conteo de paradas + minutos');

    // ── Hallazgo 2: query capture_no_vehicle_presence corre y agrega ──
    const caps = await q(`
      select dc.user_id, count(*)::int total,
        count(*) filter (where exists (
          select 1 from logistics.vehicle_stops st where st.tenant_id=dc.tenant_id
            and exists (select 1 from logistics.trackers tr where tr.vehicle_id=st.vehicle_id and tr.route_number is not null)
            and dc.hora_inicio between st.arrived_at - interval '20 minutes' and st.left_at + interval '20 minutes'
            and ${HAV} <= 200))::int witnessed
      from daily_captures dc
      where dc.tenant_id = public.current_tenant_id()
        and dc.hora_inicio >= now() - interval '30 days' and dc.latitud is not null and dc.user_id is not null
      group by dc.user_id`);
    assert(Array.isArray(caps), 'query capture_no_vehicle_presence corre sin error (SQL válido)');
    assert(caps.every(r => Number.isFinite(Number(r.total)) && Number.isFinite(Number(r.witnessed))), 'agrega total/witnessed numéricos por colaborador');

    await client.query('ROLLBACK');
    console.log(`\n✅ ${n}/${n} asserts OK\n`); process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
