/**
 * LTV.7 smoke — alerta de negocio 'stopped_with_pending'.
 * Siembra tracker detenido + embarque hoy + guía + recipient pendiente, replica
 * la regla del scanner y verifica que abre la alerta con el conteo. Self-cleaning.
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const IMEI = 'LTV7-TEST-IMEI';
let n = 0; const assert = (c, m) => { n++; if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  console.log('\n=== LTV.7 smoke: alerta detenida-con-pendientes ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  const clean = async () => {
    await client.query("delete from logistics.fleet_alerts where tracker_id in (select id from logistics.trackers where imei=$1)", [IMEI]);
    await client.query("delete from logistics.trackers where imei=$1", [IMEI]);
    await client.query("delete from logistics.guide_recipients where customer_name like 'LTV7%'");
    await client.query("delete from logistics.delivery_guides where number like 'LTV7%'");
    await client.query("delete from logistics.shipments where folio like 'LTV7%'");
  };
  try {
    await clean();
    const veh = (await q('select id from logistics.vehicles where deleted_at is null limit 1'))[0].id;
    const trk = (await q("insert into logistics.trackers (tenant_id,provider,imei,vehicle_id,active,last_status) values (public.current_tenant_id(),'magnitracking',$1,$2,true,'stopped') returning id", [IMEI, veh]))[0];
    const shp = (await q("insert into logistics.shipments (tenant_id,folio,shipment_date,vehicle_id) values (public.current_tenant_id(),'LTV7-S',current_date,$1) returning id", [veh]))[0];
    const gde = (await q("insert into logistics.delivery_guides (tenant_id,number,shipment_id,driver_commission,helper1_commission,helper2_commission,overnight,per_diem_total) values (public.current_tenant_id(),'LTV7-G',$1,0,0,0,false,0) returning id", [shp.id]))[0];
    const mkRec = (name, st) => client.query("insert into logistics.guide_recipients (tenant_id,guide_id,customer_name,boxes_count,weight_kg,value,status,collect_on_delivery) values (public.current_tenant_id(),$1,$2,0,0,0,$3,false)", [gde.id, name, st]);
    await mkRec('LTV7 pend1', 'pendiente');
    await mkRec('LTV7 pend2', 'pendiente');
    await mkRec('LTV7 hecho', 'entregado');

    // replica regla scanner
    const pend = (await q(`select count(gr.id)::int pending from logistics.shipments s join logistics.delivery_guides g on g.tenant_id=s.tenant_id and g.shipment_id=s.id join logistics.guide_recipients gr on gr.tenant_id=g.tenant_id and gr.guide_id=g.id where s.shipment_date=current_date and s.vehicle_id=$1 and gr.status='pendiente'`, [veh]))[0].pending;
    assert(pend === 2, `vehículo con 2 pedidos pendientes hoy (obtuvo ${pend})`);

    const trkRow = (await q("select last_status from logistics.trackers where id=$1", [trk.id]))[0];
    const on = trkRow.last_status === 'stopped' && pend > 0;
    assert(on, 'condición stopped_with_pending activa (detenida + pendientes)');
    await client.query("insert into logistics.fleet_alerts (tenant_id,tracker_id,vehicle_id,kind,severity,message,value,status) values (public.current_tenant_id(),$1,$2,'stopped_with_pending','warn',$3,$4,'open')", [trk.id, veh, `Detenida con ${pend} pedidos sin entregar`, pend]);
    const a = (await q("select kind, value::int v, message from logistics.fleet_alerts where tracker_id=$1 and kind='stopped_with_pending' and status='open'", [trk.id]))[0];
    assert(!!a && a.v === 2, `alerta abierta con conteo 2 (${a && a.message})`);

    await clean();
    await client.query('COMMIT');
    console.log(`\n✅ ${n}/${n} asserts OK\n`); process.exit(0);
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('\n❌', e.message, '\n'); process.exit(1); } finally { await client.end(); }
})();
