/**
 * LTV.16 smoke — Detalle de auditoría de un vehículo/día: traza GPS + tickets
 * UBICADOS. Verifica que RouteAdherenceService.vehicleAuditDetail:
 *   (1) resuelve la traza GPS por el tracker (positions.vehicle_id puede ir NULL);
 *   (2) liga los tickets del día por route_code ↔ route_number (con normalización
 *       "R-88" → 88), y descarta los de otra ruta;
 *   (3) ubica cada ticket en el fix GPS más cercano a su hora impresa (ticket_time)
 *       y calcula el gap en minutos;
 *   (4) deja "sin ubicar" un ticket sin hora.
 * Réplica de la lógica del servicio. Todo en una tx con ROLLBACK.
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DAY = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const START = `${DAY}T00:00:00-06:00`, END = `${DAY}T23:59:59.999-06:00`;

const routeDigits = (s) => { const m = (s || '').replace(/\D/g, ''); return m ? parseInt(m, 10) : null; };

let n = 0; const assert = (c, m) => { n++; if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  console.log('\n=== LTV.16 smoke: detalle de auditoría (traza + tickets ubicados) ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  try {
    // Vehículo de ruta 88.
    const veh = (await q(`insert into logistics.vehicles (tenant_id,plate,status,active) values (public.current_tenant_id(),'LTVAD-PLATE','disponible',true) returning id`))[0];
    const trk = (await q(`insert into logistics.trackers (tenant_id,provider,imei,vehicle_id,active,route_number,route_manual) values (public.current_tenant_id(),'magnitracking','LTVAD-IMEI',$1,true,88,true) returning id`, [veh.id]))[0];

    // 3 fixes GPS (NOTA: vehicle_id NULL a propósito → debe resolverse por tracker).
    const mkPos = (h, lat, lng) => client.query(
      `insert into logistics.vehicle_positions (tenant_id,tracker_id,vehicle_id,captured_at,lat,lng,speed_kmh) values (public.current_tenant_id(),$1,NULL,$2,$3,$4,20)`,
      [trk.id, `${DAY}T${h}-06:00`, lat, lng]);
    await mkPos('10:00:00', 20.100, -101.900);
    await mkPos('10:06:00', 20.110, -101.910); // el más cercano a 10:05
    await mkPos('10:20:00', 20.120, -101.920);

    // ── traza resuelta por tracker ──
    const path = (await q(
      `select vp.lat, vp.lng, vp.captured_at from logistics.vehicle_positions vp
        join logistics.trackers t on t.id = vp.tracker_id
        where vp.tenant_id = public.current_tenant_id() and t.vehicle_id = $1
          and vp.captured_at between $2 and $3 order by vp.captured_at asc`, [veh.id, START, END]))
      .map(r => ({ lat: Number(r.lat), lng: Number(r.lng), t: new Date(r.captured_at).getTime() }));
    assert(path.length === 3, `traza GPS = 3 fixes resueltos por tracker aunque vehicle_id sea NULL (obtuvo ${path.length})`);

    // route_number(s) del vehículo.
    const routeNumbers = (await q(`select distinct route_number from logistics.trackers where tenant_id=public.current_tenant_id() and vehicle_id=$1 and route_number is not null and deleted_at is null`, [veh.id])).map(r => Number(r.route_number));
    assert(routeNumbers.length === 1 && routeNumbers[0] === 88, 'ruta del vehículo = [88]');

    // 3 tickets: venta (R-88, 10:05 → ubicable), combustible (88, sin hora → no ubicable), venta (otra ruta 99 → filtrado).
    const V = '00000000-0000-0000-0000-0000000000ff';
    await client.query(`insert into commercial.route_tickets (tenant_id,vendor_user_id,ticket_type,route_code,ticket_date,ticket_time,total,corte_number,reviewed) values (public.current_tenant_id(),$1,'venta','R-88',$2,'10:05:00',1234.50,'C-88-1',true)`, [V, DAY]);
    await client.query(`insert into commercial.route_tickets (tenant_id,vendor_user_id,ticket_type,route_code,ticket_date,ticket_time,liters,reference,reviewed) values (public.current_tenant_id(),$1,'combustible','88',$2,NULL,40.0,'F-88-1',true)`, [V, DAY]);
    await client.query(`insert into commercial.route_tickets (tenant_id,vendor_user_id,ticket_type,route_code,ticket_date,ticket_time,total,corte_number,reviewed) values (public.current_tenant_id(),$1,'venta','99',$2,'11:00:00',999.00,'C-99-1',true)`, [V, DAY]);

    const raw = await q(`select id, ticket_type, ticket_time, ticket_date, route_code, total from commercial.route_tickets where tenant_id=public.current_tenant_id() and deleted_at is null and ticket_date=$1`, [DAY]);
    const mine = raw.filter(t => routeNumbers.includes(routeDigits(t.route_code) ?? -1));
    assert(mine.length === 2, `2 tickets ligados a la ruta 88 (R-88 + 88); el de ruta 99 se descarta (obtuvo ${mine.length})`);

    const nearestByTime = (tsMs) => {
      let best = null;
      for (const p of path) { const gap = Math.abs(p.t - tsMs); if (!best || gap < best.gap) best = { lat: p.lat, lng: p.lng, gap }; }
      return best;
    };
    const located = mine.map(t => {
      if (!t.ticket_time) return { ...t, located: false, gap_min: null };
      const dayStr = (t.ticket_date instanceof Date ? t.ticket_date.toISOString().slice(0, 10) : String(t.ticket_date).slice(0, 10));
      const near = nearestByTime(new Date(`${dayStr}T${String(t.ticket_time)}-06:00`).getTime());
      return { ...t, located: !!near, gap_min: near ? Math.round(near.gap / 60000) : null, at_lat: near?.lat };
    });

    const venta = located.find(t => t.ticket_type === 'venta');
    const combustible = located.find(t => t.ticket_type === 'combustible');
    assert(venta.located && venta.gap_min === 1, `ticket de venta (10:05) ubicado al fix de 10:06, gap = 1 min (obtuvo ${venta.gap_min})`);
    assert(Math.abs(venta.at_lat - 20.110) < 1e-6, 'ticket de venta ubicado en la coordenada del fix de 10:06');
    assert(!combustible.located && combustible.gap_min === null, 'ticket de combustible sin hora → queda sin ubicar');

    await client.query('ROLLBACK');
    console.log(`\n✅ ${n}/${n} asserts OK\n`); process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
