/**
 * LTV.1 smoke — cumplimiento de ruta (plan vs real).
 *
 * Siembra ruta + 3 clientes (2 con coords, 1 sin) + embarque vehículo→ruta +
 * paradas (1 matchea cliente A, 1 fuera de ruta), replica la lógica del
 * RouteAdherenceService y verifica plan/visitados/saltados/fuera-de-ruta/coverage.
 * Self-cleaning.
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DAY = '2020-01-02';
const START = `${DAY}T00:00:00-06:00`, END = `${DAY}T23:59:59.999-06:00`;

let assertions = 0;
const assert = (c, m) => { assertions++; if (!c) throw new Error('ASSERT FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  console.log('\n=== LTV.1 smoke: cumplimiento de ruta ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  try {
    const veh = (await q('select id from logistics.vehicles where deleted_at is null limit 1'))[0];

    // cleanup previo
    await client.query("delete from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3", [veh.id, START, END]);
    await client.query("delete from logistics.shipments where folio like 'LTVADH-%'");
    await client.query("delete from commercial.customers where code like 'LTVADH-%'");
    await client.query("delete from logistics.routes where name='LTV-ADH-TEST'");

    const route = (await q("insert into logistics.routes (tenant_id,name) values (public.current_tenant_id(),'LTV-ADH-TEST') returning id"))[0];
    const mkCust = async (code, name, seq, lat, lng) => (await q(
      `insert into commercial.customers (tenant_id,code,name,route_id,visit_sequence,latitude,longitude,credit_limit,balance,payment_terms_days,active,is_casual)
       values (public.current_tenant_id(),$1,$2,$3,$4,$5,$6,0,0,0,true,false) returning id`,
      [code, name, route.id, seq, lat, lng]))[0];
    const cA = await mkCust('LTVADH-A', 'Cliente A', 1, 19.7, -101.2);
    const cB = await mkCust('LTVADH-B', 'Cliente B', 2, 19.71, -101.21);
    await mkCust('LTVADH-C', 'Cliente C sin coords', 3, null, null);

    await client.query(
      `insert into logistics.shipments (tenant_id,folio,shipment_date,vehicle_id,route_id) values (public.current_tenant_id(),$1,$2,$3,$4)`,
      [`LTVADH-${DAY}`, DAY, veh.id, route.id]);

    // paradas: A visitado + una fuera de ruta (sin cliente) — arrived_at distinto
    const mkStop = async (hour, mins, lat, lng, matched) => client.query(
      `insert into logistics.vehicle_stops (tenant_id,vehicle_id,arrived_at,left_at,minutes,lat,lng,matched_customer_id,is_customer) values (public.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8)`,
      [veh.id, new Date(`${DAY}T${hour}:00:00-06:00`).toISOString(), new Date(`${DAY}T${hour}:${String(mins).padStart(2, '0')}:00-06:00`).toISOString(), mins, lat, lng, matched, !!matched]);
    await mkStop(15, 10, 19.7, -101.2, cA.id);
    await mkStop(16, 20, 20.5, -102.5, null); // fuera de ruta

    // ── replica de RouteAdherenceService.forVehicleDay ──
    const routeIds = (await q("select distinct route_id from logistics.shipments where vehicle_id=$1 and shipment_date=$2 and route_id is not null", [veh.id, DAY])).map(r => r.route_id);
    const planned = await q("select id customer_id, code, name, visit_sequence, latitude from commercial.customers where route_id = any($1) and deleted_at is null order by visit_sequence asc nulls last", [routeIds]);
    const stops = await q("select matched_customer_id, is_customer from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3", [veh.id, START, END]);
    const visited = new Set(stops.filter(s => s.matched_customer_id).map(s => s.matched_customer_id));
    const plannedIds = new Set(planned.map(p => p.customer_id));
    const withCoords = planned.filter(p => p.latitude != null);
    const visitedCount = withCoords.filter(p => visited.has(p.customer_id)).length;
    const skipped = withCoords.filter(p => !visited.has(p.customer_id));
    const offRoute = stops.filter(s => !s.matched_customer_id || !plannedIds.has(s.matched_customer_id));
    const coverage = withCoords.length ? Math.round((visitedCount / withCoords.length) * 100) : null;

    assert(routeIds.length === 1, 'resolvió 1 ruta servida por la unidad ese día');
    assert(planned.length === 3, `plan = 3 clientes de la ruta (obtuvo ${planned.length})`);
    assert(withCoords.length === 2, '2 clientes del plan son evaluables (con coords)');
    assert(visitedCount === 1 && visited.has(cA.id), 'cliente A contó como visitado');
    assert(skipped.length === 1 && skipped[0].customer_id === cB.id, 'cliente B (con coords, sin parada) contó como saltado');
    assert(offRoute.length === 1, 'detectó 1 parada fuera de ruta');
    assert(coverage === 50, `coverage = 50% (obtuvo ${coverage})`);

    // cleanup
    await client.query("delete from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3", [veh.id, START, END]);
    await client.query("delete from logistics.shipments where folio like 'LTVADH-%'");
    await client.query("delete from commercial.customers where code like 'LTVADH-%'");
    await client.query("delete from logistics.routes where name='LTV-ADH-TEST'");
    await client.query('COMMIT');
    console.log(`\n✅ ${assertions}/${assertions} asserts OK\n`); process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
