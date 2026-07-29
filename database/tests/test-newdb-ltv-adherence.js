/**
 * LTV.1/13 smoke — Cumplimiento de RUTA contra tiendas de trade (doble testigo).
 *
 * El plan ya NO es la cartera comercial: es las tiendas (public.stores) de la
 * ruta dominante que la unidad tocó; lo real = tiendas donde el camión se detuvo;
 * captura = si hubo captura de auditoría cerca. Siembra una unidad de ruta +
 * paradas matcheadas a tiendas existentes (ruta_id de prueba), replica la lógica
 * de RouteAdherenceService.computeForVehicle (trade) y verifica plan/visitadas/
 * saltadas/fuera-de-ruta/cobertura. Todo en una tx con ROLLBACK (no persiste).
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const RT = '11111111-1111-1111-1111-1111110000aa'; // ruta de prueba
const RD = '11111111-1111-1111-1111-1111110000dd'; // otra ruta (off-route)
const DAY = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const START = `${DAY}T00:00:00-06:00`, END = `${DAY}T23:59:59.999-06:00`;
const HAV = `2 * 6371000 * asin(sqrt(power(sin(radians(dc.latitud::float8 - st.lat::float8)/2),2) + cos(radians(st.lat::float8))*cos(radians(dc.latitud::float8))*power(sin(radians(dc.longitud::float8 - st.lng::float8)/2),2)))`;

let n = 0; const assert = (c, m) => { n++; if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  console.log('\n=== LTV.1/13 smoke: cumplimiento de ruta (tiendas trade) ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  try {
    // 5 tiendas con coords (A,B,C,D en RT; E en RD off-route). C se vuelve sin-coords.
    const stores = await q(`select id, latitud, longitud from public.stores where latitud is not null and longitud is not null and deleted_at is null limit 5`);
    assert(stores.length === 5, `hay 5 tiendas geolocalizadas para el test (obtuvo ${stores.length})`);
    const [sA, sB, sC, sD, sE] = stores;
    // Rutas de prueba en catalogs (FK stores.ruta_id → catalogs). Ids frescos = plan limpio.
    await client.query(`insert into catalogs (id, tenant_id, catalog_id, value) values ($1, public.current_tenant_id(), 'rutas', 'LTV Test Ruta'), ($2, public.current_tenant_id(), 'rutas', 'LTV Test Ruta D')`, [RT, RD]);
    await client.query(`update public.stores set ruta_id=$1 where id = any($2)`, [RT, [sA.id, sB.id, sC.id, sD.id]]);
    await client.query(`update public.stores set ruta_id=$1 where id=$2`, [RD, sE.id]);
    await client.query(`update public.stores set latitud=null, longitud=null where id=$1`, [sC.id]); // sin coords

    const veh = (await q(`insert into logistics.vehicles (tenant_id,plate,status,active) values (public.current_tenant_id(),'LTVADH-PLATE','disponible',true) returning id`))[0];
    await client.query(`insert into logistics.trackers (tenant_id,provider,imei,vehicle_id,active,route_number,route_manual) values (public.current_tenant_id(),'magnitracking','LTVADH-IMEI',$1,true,77,true)`, [veh.id]);

    // paradas del camión: A y B (en RT) + E (off-route RD). D queda saltada.
    const mkStop = async (store, h) => client.query(
      `insert into logistics.vehicle_stops (tenant_id,vehicle_id,arrived_at,left_at,minutes,lat,lng,matched_store_id,is_customer) values (public.current_tenant_id(),$1,$2,$3,10,$4,$5,$6,false)`,
      [veh.id, `${DAY}T${h}:00:00-06:00`, `${DAY}T${h}:10:00-06:00`, store.latitud, store.longitud, store.id]);
    await mkStop(sA, '10'); await mkStop(sB, '11'); await mkStop(sE, '12');

    // ── replica computeForVehicle (trade) ──
    const stopRows = await q(`
      select st.matched_store_id store_id, s.ruta_id, st.lat, st.lng,
        EXISTS (SELECT 1 FROM public.daily_captures dc WHERE dc.tenant_id=st.tenant_id
          AND dc.hora_inicio BETWEEN st.arrived_at - interval '10 minutes' AND st.left_at + interval '10 minutes'
          AND dc.latitud IS NOT NULL AND dc.longitud IS NOT NULL AND ${HAV} <= 150) as captured
      from logistics.vehicle_stops st join public.stores s on s.id=st.matched_store_id
      where st.vehicle_id=$1 and st.arrived_at between $2 and $3 and st.matched_store_id is not null`, [veh.id, START, END]);
    const routeCount = new Map();
    for (const r of stopRows) if (r.ruta_id) routeCount.set(r.ruta_id, (routeCount.get(r.ruta_id) || 0) + 1);
    let dominant = null, best = 0; for (const [rid, c] of routeCount) if (c > best) { best = c; dominant = rid; }
    const visited = new Set(stopRows.map(s => s.store_id));
    const captured = new Set(stopRows.filter(s => s.captured).map(s => s.store_id));
    const planned = await q(`select id store_id, latitud from public.stores where ruta_id=$1 and deleted_at is null`, [dominant]);
    const withCoords = planned.filter(p => p.latitud != null);
    const visitedCount = withCoords.filter(p => visited.has(p.store_id)).length;
    const capturedCount = withCoords.filter(p => captured.has(p.store_id)).length;
    const plannedIds = new Set(planned.map(p => p.store_id));
    const skipped = withCoords.filter(p => !visited.has(p.store_id));
    const offRoute = stopRows.filter(s => !plannedIds.has(s.store_id));
    const coverage = withCoords.length ? Math.round((visitedCount / withCoords.length) * 100) : null;

    assert(dominant === RT, `ruta dominante = RT (obtuvo ${dominant === RT ? 'RT' : dominant})`);
    assert(planned.length === 4, `plan = 4 tiendas de la ruta (obtuvo ${planned.length})`);
    assert(withCoords.length === 3, `3 tiendas evaluables (con coords), sin contar la sin-coords (obtuvo ${withCoords.length})`);
    assert(visitedCount === 2, `2 tiendas visitadas: A y B (obtuvo ${visitedCount})`);
    assert(skipped.length === 1 && skipped[0].store_id === sD.id, 'tienda D contó como saltada');
    assert(offRoute.length === 1, `1 parada fuera de ruta: E (obtuvo ${offRoute.length})`);
    assert(coverage === 67, `cobertura = 67% (obtuvo ${coverage})`);
    assert(capturedCount === 0, `0 con captura (no se sembraron capturas) (obtuvo ${capturedCount})`);

    await client.query('ROLLBACK');
    console.log(`\n✅ ${n}/${n} asserts OK\n`); process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
