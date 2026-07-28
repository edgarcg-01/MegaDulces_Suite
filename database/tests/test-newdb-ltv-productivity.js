/**
 * LTV.5 smoke — productividad / tiempos muertos.
 * Siembra un resumen diario + 2 paradas (1 cliente, 1 muerta 30min) y verifica
 * el cálculo de dead_min / dead_stops / km_per_customer_stop. Self-cleaning.
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DAY = '2020-01-03', START = `${DAY}T00:00:00-06:00`, END = `${DAY}T23:59:59.999-06:00`;
const DEAD = 20;
let n = 0; const assert = (c, m) => { n++; if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  console.log('\n=== LTV.5 smoke: productividad ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  const clean = async (veh) => { await client.query('delete from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3', [veh, START, END]); await client.query('delete from logistics.vehicle_day_summary where vehicle_id=$1 and day=$2', [veh, DAY]); };
  try {
    const veh = (await q('select id from logistics.vehicles where deleted_at is null limit 1'))[0].id;
    await clean(veh);
    await client.query('insert into logistics.vehicle_day_summary (tenant_id,vehicle_id,day,km_driven,moving_min,stopped_min,offline_min,stops_count,customer_stops) values (public.current_tenant_id(),$1,$2,40,120,60,0,2,1)', [veh, DAY]);
    const mkStop = (h, min, isCust) => client.query('insert into logistics.vehicle_stops (tenant_id,vehicle_id,arrived_at,left_at,minutes,lat,lng,is_customer) values (public.current_tenant_id(),$1,$2,$3,$4,19.7,-101.2,$5)', [veh, `${DAY}T${h}:00:00-06:00`, `${DAY}T${h}:${String(min).padStart(2, '0')}:00-06:00`, min, isCust]);
    await mkStop(15, 10, true);   // parada de cliente
    await mkStop(16, 30, false);  // parada muerta (30 min, sin cliente)

    // replica de FleetProductivityService.forFleetDay
    const s = (await q('select km_driven::float km, customer_stops from logistics.vehicle_day_summary where vehicle_id=$1 and day=$2', [veh, DAY]))[0];
    const d = (await q('select coalesce(sum(minutes),0)::int dead_min, count(*)::int dead_stops from logistics.vehicle_stops where vehicle_id=$1 and arrived_at between $2 and $3 and is_customer=false and minutes>=$4', [veh, START, END, DEAD]))[0];
    const kmPer = s.customer_stops > 0 ? Math.round((s.km / s.customer_stops) * 100) / 100 : null;

    assert(d.dead_min === 30 && d.dead_stops === 1, `tiempo muerto = 30 min en 1 parada (obtuvo ${d.dead_min}/${d.dead_stops})`);
    assert(kmPer === 40, `km por parada de cliente = 40 (obtuvo ${kmPer})`);
    assert(s.customer_stops === 1, '1 parada productiva (cliente)');

    await clean(veh);
    await client.query('COMMIT');
    console.log(`\n✅ ${n}/${n} asserts OK\n`); process.exit(0);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('\n❌', e.message, '\n'); process.exit(1); } finally { await client.end(); }
})();
