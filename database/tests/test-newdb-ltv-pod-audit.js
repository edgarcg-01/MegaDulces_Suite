/**
 * LTV.3 smoke — auditoría georreferenciada de POD.
 *
 * Siembra chofer + embarque + guía + 2 recipients entregados (uno LEJOS del
 * cliente >300m, uno cerca), replica PodGeoAuditService y verifica que se abre un
 * hallazgo 'pod_far_from_customer' en la bandeja Horus (supervisor_findings) para
 * el chofer, con evidencia de distancia. Idempotente + self-cleaning.
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let assertions = 0;
const assert = (c, m) => { assertions++; if (!c) throw new Error('ASSERT FAIL: ' + m); console.log('  ✓ ' + m); };
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

(async () => {
  console.log('\n=== LTV.3 smoke: auditoría POD georef ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  const cleanup = async () => {
    await client.query("delete from logistics.guide_recipients where customer_name like 'LTVPOD%'");
    await client.query("delete from logistics.delivery_guides where number like 'LTVPOD%'");
    await client.query("delete from logistics.shipments where folio like 'LTVPOD%'");
    await client.query("delete from commercial.customers where code like 'LTVPOD%'");
    await client.query("delete from commercial.supervisor_findings where label='LTVPOD Chofer'");
    await client.query("delete from logistics.drivers where full_name='LTVPOD Chofer'");
  };
  try {
    await cleanup();
    const drv = (await q("insert into logistics.drivers (tenant_id,full_name,roles,employee_type,status,active) values (public.current_tenant_id(),'LTVPOD Chofer','{chofer}','interno','activo',true) returning id"))[0];
    const shp = (await q("insert into logistics.shipments (tenant_id,folio,shipment_date) values (public.current_tenant_id(),'LTVPOD-S',current_date) returning id"))[0];
    const gde = (await q("insert into logistics.delivery_guides (tenant_id,number,shipment_id,driver_id,driver_commission,helper1_commission,helper2_commission,overnight,per_diem_total) values (public.current_tenant_id(),'LTVPOD-G',$1,$2,0,0,0,false,0) returning id", [shp.id, drv.id]))[0];
    const cust = (await q("insert into commercial.customers (tenant_id,code,name,latitude,longitude,credit_limit,balance,payment_terms_days,active,is_casual) values (public.current_tenant_id(),'LTVPOD-C','Cliente POD',19.70,-101.20,0,0,0,true,false) returning id"))[0];
    const mkRec = async (name, lat, lng) => client.query(
      "insert into logistics.guide_recipients (tenant_id,guide_id,customer_id,customer_name,boxes_count,weight_kg,value,status,collect_on_delivery,gps_lat,gps_lng,delivered_at) values (public.current_tenant_id(),$1,$2,$3,0,0,0,'entregado',false,$4,$5,now())",
      [gde.id, cust.id, name, lat, lng]);
    await mkRec('LTVPOD lejos', 19.75, -101.25); // ~6.5 km del cliente → far
    await mkRec('LTVPOD cerca', 19.7001, -101.2001); // ~15 m → ok

    // ── replica de PodGeoAuditService.generateForTenant ──
    const recs = await q(`
      select gr.id recipient_id, gr.gps_lat, gr.gps_lng, g.driver_id, d.user_id driver_user_id, d.full_name driver_name, c.latitude, c.longitude
      from logistics.guide_recipients gr
      join logistics.delivery_guides g on g.tenant_id=gr.tenant_id and g.id=gr.guide_id
      left join logistics.drivers d on d.tenant_id=g.tenant_id and d.id=g.driver_id
      left join commercial.customers c on c.tenant_id=gr.tenant_id and c.id=gr.customer_id
      where gr.tenant_id=$1 and gr.status='entregado' and gr.customer_name like 'LTVPOD%'`, [TENANT]);
    assert(recs.length === 2, 'query trae los 2 recipients entregados');
    const agg = new Map();
    for (const r of recs) {
      const sid = r.driver_user_id || r.driver_id; if (!sid) continue;
      let a = agg.get(sid) || { label: r.driver_name, far: 0, maxDist: 0 }; agg.set(sid, a);
      const pl = Number(r.gps_lat), pn = Number(r.gps_lng), cl = Number(r.latitude), cn = Number(r.longitude);
      if (Number.isFinite(pl) && Number.isFinite(cl)) { const dd = haversineM(pl, pn, cl, cn); if (dd > 300) { a.far++; a.maxDist = Math.max(a.maxDist, Math.round(dd)); } }
    }
    const a = agg.get(drv.id);
    assert(a && a.far === 1, `1 entrega lejos detectada para el chofer (far=${a && a.far})`);
    assert(a.maxDist > 300, `distancia máx > 300m (${a.maxDist}m)`);

    // upsert del hallazgo (mirror)
    await client.query(
      `insert into commercial.supervisor_findings (tenant_id,dedup_key,finding_type,severity,subject_type,subject_id,label,score,evidence,source,status)
       values (public.current_tenant_id(),$1,'pod_far_from_customer',$2,'collaborator',$3,'LTVPOD Chofer',$4,$5,'fraud','open')
       on conflict (tenant_id,dedup_key) do update set severity=excluded.severity, evidence=excluded.evidence, updated_at=now()`,
      [`pod_far_from_customer:collaborator:${drv.id}`, a.maxDist >= 1000 ? 'critical' : 'warn', drv.id, a.far, JSON.stringify({ events: a.far, max_distance_m: a.maxDist, threshold_m: 300 })]);

    const f = (await q("select finding_type, severity, source, subject_id, evidence from commercial.supervisor_findings where subject_id=$1 and finding_type='pod_far_from_customer' and status='open'", [drv.id]))[0];
    assert(!!f && f.source === 'fraud', 'hallazgo pod_far_from_customer creado en la bandeja Horus (source=fraud)');
    assert(f.evidence && Number(f.evidence.max_distance_m) > 300, 'evidencia lleva la distancia (números deterministas, sin LLM)');

    await cleanup();
    await client.query('COMMIT');
    console.log(`\n✅ ${assertions}/${assertions} asserts OK\n`); process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
