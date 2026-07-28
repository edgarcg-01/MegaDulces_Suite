/**
 * LTV.1 + LTV.11 smoke — cumplimiento de reparto por "unidad de ruta".
 *
 * El plan ya NO sale de shipments.route_id (vacío) sino de la cadena
 * camión → tracker.route_number → clientes por sales_route ("RUTA 77").
 * Siembra vehículo + tracker(route_number=77) + 3 clientes con sales_route
 * (2 con coords, 1 sin) + paradas (A visitado, 1 fuera de ruta), replica la
 * lógica del RouteAdherenceService nuevo y verifica plan/visitados/saltados/
 * fuera-de-ruta/coverage. Self-cleaning.
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DAY = '2020-01-02';
const START = `${DAY}T00:00:00-06:00`, END = `${DAY}T23:59:59.999-06:00`;
const RN = 77; // número de ruta de prueba (distintivo)

let assertions = 0;
const assert = (c, m) => { assertions++; if (!c) throw new Error('ASSERT FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  console.log('\n=== LTV.1/11 smoke: cumplimiento por unidad de ruta ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  const clean = async () => {
    await client.query("delete from logistics.vehicle_stops where vehicle_id in (select id from logistics.vehicles where plate='LTVADH-PLATE')");
    await client.query("delete from logistics.trackers where imei='LTVADH-IMEI'");
    await client.query("delete from logistics.vehicles where plate='LTVADH-PLATE'");
    await client.query("delete from commercial.customers where code like 'LTVADH-%'");
  };
  try {
    await clean();
    const veh = (await q("insert into logistics.vehicles (tenant_id,plate,status,active) values (public.current_tenant_id(),'LTVADH-PLATE','disponible',true) returning id"))[0];
    // Tracker de la unidad con ruta 77 (la clave de la "unidad de ruta").
    await client.query(
      "insert into logistics.trackers (tenant_id,provider,imei,vehicle_id,active,route_number,route_manual) values (public.current_tenant_id(),'magnitracking','LTVADH-IMEI',$1,true,$2,true)",
      [veh.id, RN]);

    const mkCust = async (code, name, seq, lat, lng) => (await q(
      `insert into commercial.customers (tenant_id,code,name,sales_route,visit_sequence,latitude,longitude,credit_limit,balance,payment_terms_days,active,is_casual)
       values (public.current_tenant_id(),$1,$2,$3,$4,$5,$6,0,0,0,true,false) returning id`,
      [code, name, `RUTA ${RN}`, seq, lat, lng]))[0];
    const cA = await mkCust('LTVADH-A', 'Cliente A', 1, 19.7, -101.2);
    const cB = await mkCust('LTVADH-B', 'Cliente B', 2, 19.71, -101.21);
    await mkCust('LTVADH-C', 'Cliente C sin coords', 3, null, null);

    const mkStop = async (hour, mins, lat, lng, matched) => client.query(
      `insert into logistics.vehicle_stops (tenant_id,vehicle_id,arrived_at,left_at,minutes,lat,lng,matched_customer_id,is_customer) values (public.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8)`,
      [veh.id, new Date(`${DAY}T${hour}:00:00-06:00`).toISOString(), new Date(`${DAY}T${hour}:${String(mins).padStart(2, '0')}:00-06:00`).toISOString(), mins, lat, lng, matched, !!matched]);
    await mkStop(15, 10, 19.7, -101.2, cA.id);
    await mkStop(16, 20, 20.5, -102.5, null); // fuera de ruta

    // ── replica de RouteAdherenceService.computeForVehicle (nuevo) ──
    const rn = (await q("select route_number from logistics.trackers where vehicle_id=$1 and route_number is not null limit 1", [veh.id]))[0]?.route_number ?? null;
    const planned = rn != null ? await q(
      `select id customer_id, code, name, visit_sequence, latitude from commercial.customers
       where deleted_at is null and sales_route ~* ('(^|[^0-9])0*' || $1::text || '([^0-9]|$)')
       order by visit_sequence asc nulls last`, [String(rn)]) : [];
    const stops = await q("select matched_customer_id, is_customer from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3", [veh.id, START, END]);
    const visited = new Set(stops.filter(s => s.matched_customer_id).map(s => s.matched_customer_id));
    const plannedIds = new Set(planned.map(p => p.customer_id));
    const withCoords = planned.filter(p => p.latitude != null);
    const visitedCount = withCoords.filter(p => visited.has(p.customer_id)).length;
    const skipped = withCoords.filter(p => !visited.has(p.customer_id));
    const offRoute = stops.filter(s => !s.matched_customer_id || !plannedIds.has(s.matched_customer_id));
    const coverage = withCoords.length ? Math.round((visitedCount / withCoords.length) * 100) : null;

    assert(rn === RN, `resolvió route_number ${RN} desde el tracker de la unidad (obtuvo ${rn})`);
    assert(planned.length === 3, `plan = 3 clientes por sales_route "RUTA ${RN}" (obtuvo ${planned.length})`);
    assert(withCoords.length === 2, '2 clientes del plan son evaluables (con coords)');
    assert(visitedCount === 1 && visited.has(cA.id), 'cliente A contó como visitado');
    assert(skipped.length === 1 && skipped[0].customer_id === cB.id, 'cliente B (con coords, sin parada) contó como saltado');
    assert(offRoute.length === 1, 'detectó 1 parada fuera de ruta');
    assert(coverage === 50, `coverage = 50% (obtuvo ${coverage})`);

    await clean();
    await client.query('COMMIT');
    console.log(`\n✅ ${assertions}/${assertions} asserts OK\n`); process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
