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

    // ── enriquecimiento de paradas: seq + in_plan + kind (Fase 1) ──
    const RT = '22222222-2222-2222-2222-2222220000aa', RD = '22222222-2222-2222-2222-2222220000dd';
    const stores = await q(`select id, latitud, longitud from public.stores where latitud is not null and longitud is not null and deleted_at is null limit 3`);
    if (stores.length === 3) {
      const [sA, sB, sE] = stores;
      await client.query(`insert into catalogs (id,tenant_id,catalog_id,value) values ($1,public.current_tenant_id(),'rutas','LTV16 RT'),($2,public.current_tenant_id(),'rutas','LTV16 RD')`, [RT, RD]);
      await client.query(`update public.stores set ruta_id=$1 where id = any($2)`, [RT, [sA.id, sB.id]]);
      await client.query(`update public.stores set ruta_id=$1 where id=$2`, [RD, sE.id]);
      const mkStop = (store, h) => client.query(
        `insert into logistics.vehicle_stops (tenant_id,vehicle_id,arrived_at,left_at,minutes,lat,lng,matched_store_id,is_customer) values (public.current_tenant_id(),$1,$2,$3,10,$4,$5,$6,false)`,
        [veh.id, `${DAY}T${h}:00:00-06:00`, `${DAY}T${h}:12:00-06:00`, store ? store.latitud : 20.5, store ? store.longitud : -101.5, store ? store.id : null]);
      await mkStop(sA, '09'); await mkStop(sB, '10'); await mkStop(sE, '11'); await mkStop(null, '12'); // 4a sin tienda

      const raw = await q(`select st.arrived_at, st.matched_store_id, s.ruta_id from logistics.vehicle_stops st left join public.stores s on s.id=st.matched_store_id where st.vehicle_id=$1 and st.arrived_at between $2 and $3 order by st.arrived_at asc`, [veh.id, START, END]);
      const freq = new Map(); for (const r of raw) if (r.ruta_id) freq.set(r.ruta_id, (freq.get(r.ruta_id) || 0) + 1);
      let dom = null, best = 0; for (const [rid, c] of freq) if (c > best) { best = c; dom = rid; }
      const enriched = raw.map((r, i) => {
        const inPlan = !!r.matched_store_id && !!dom && r.ruta_id === dom;
        const kind = !r.matched_store_id ? 'unmatched' : inPlan ? 'plan_store' : 'off_route';
        return { seq: i + 1, kind, in_plan: inPlan };
      });
      assert(dom === RT, `ruta dominante de paradas = RT (2 tiendas) (obtuvo ${dom === RT ? 'RT' : dom})`);
      assert(enriched[0].seq === 1 && enriched[3].seq === 4, 'seq cronológico 1..4');
      assert(enriched[0].kind === 'plan_store' && enriched[0].in_plan, 'parada 1 (tienda de su ruta) → plan_store + in_plan');
      assert(enriched[2].kind === 'off_route' && !enriched[2].in_plan, 'parada 3 (tienda de otra ruta) → off_route');
      assert(enriched[3].kind === 'unmatched', 'parada 4 (sin tienda) → unmatched');
    } else {
      console.log('  ⚠ (skip enriquecimiento de paradas: se necesitan 3 tiendas geolocalizadas)');
    }

    await client.query('ROLLBACK');
    console.log(`\n✅ ${n}/${n} asserts OK\n`); process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
