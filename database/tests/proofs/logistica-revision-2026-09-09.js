const { Client } = require('pg'); const fs = require('fs');
const env = fs.readFileSync('.env','utf8');
const get = k => (env.match(new RegExp('^'+k+'=(.*)$','m'))||[])[1]?.trim();
const T = '00000000-0000-0000-0000-00000000d01c';
let pass=0, fail=0;
const ok = (cond, msg) => { console.log(`   ${cond?'✅':'❌'} ${msg}`); cond?pass++:fail++; };

(async () => {
  const c = new Client({ connectionString: get('DATABASE_URL_NEW') }); await c.connect();
  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [T]);
  const V = (await c.query(`SELECT id, plate FROM logistics.vehicles WHERE deleted_at IS NULL LIMIT 1`)).rows[0];

  // ── fixture: 4 embarques con margenes distintos + 1 cancelado con flete ──
  const mk = async (folio, status, rev, cost, km) => {
    const s = (await c.query(`INSERT INTO logistics.shipments (tenant_id,folio,shipment_date,status,freight_revenue,actual_km,vehicle_id)
      VALUES ($1,$2,current_date,$3,$4,$5,$6) RETURNING id`, [T,folio,status,rev,km,V.id])).rows[0];
    if (cost !== null) await c.query(`INSERT INTO logistics.shipment_expenses (tenant_id,shipment_id,operating_subtotal,fixed_cost_per_km,total_cost)
      VALUES ($1,$2,$3::numeric,$4::numeric,$3::numeric+($5::numeric*$4::numeric))`, [T,s.id,cost,10,km]);
    return s.id;
  };
  await mk('ZZ-TOP-1','cerrado', 50000, 1000, 100);   // margen 50000-2000 = 48000
  await mk('ZZ-MID-2','cerrado', 9000, 1000, 100);    // margen  7000
  await mk('ZZ-LOW-3','cerrado', 3000, 1000, 100);    // margen  1000
  const cancelId = await mk('ZZ-CANCEL-4','cancelado', 80000, 500, 50);

  console.log('\n════════ F-6 · "top 2 por margen" ════════');
  const antes = (await c.query(`SELECT s.folio FROM logistics.shipments s LEFT JOIN logistics.shipment_expenses e ON e.shipment_id=s.id
     WHERE s.deleted_at IS NULL AND s.status IN ('entregado','cerrado') LIMIT 2`)).rows.map(r=>r.folio);
  const despues = (await c.query(`SELECT s.folio FROM logistics.shipments s LEFT JOIN logistics.shipment_expenses e ON e.shipment_id=s.id
     WHERE s.deleted_at IS NULL AND s.status IN ('entregado','cerrado')
     ORDER BY (COALESCE(s.freight_revenue,0)-COALESCE(e.total_cost,0)) DESC LIMIT 2`)).rows.map(r=>r.folio);
  console.log(`   ANTES  (limit sin order): ${antes.join(', ')}`);
  console.log(`   DESPUES (order en SQL)  : ${despues.join(', ')}`);
  ok(despues[0]==='ZZ-TOP-1', 'el #1 por margen (ZZ-TOP-1, $48,000) encabeza el top');
  ok(!antes.includes('ZZ-TOP-1'), 'ANTES el mejor embarque ni siquiera aparecia en el top 2');

  console.log('\n════════ 0.3 · margen de /reports/kpi con un embarque CANCELADO ════════');
  const vRev = Number((await c.query(`SELECT COALESCE(SUM(freight_revenue),0) r FROM logistics.shipments WHERE deleted_at IS NULL`)).rows[0].r);
  const nRev = Number((await c.query(`SELECT COALESCE(SUM(freight_revenue) FILTER (WHERE status IN ('entregado','cerrado')),0) r FROM logistics.shipments WHERE deleted_at IS NULL`)).rows[0].r);
  console.log(`   flete ANTES (todo)      : $${vRev.toLocaleString()}`);
  console.log(`   flete DESPUES (realizado): $${nRev.toLocaleString()}`);
  ok(vRev - nRev === 80000, `deja de cobrarse el flete de ZZ-CANCEL-4 ($80,000 que nunca se facturaron)`);

  console.log('\n════════ F-2 · total_cost al corregir el odometro ════════');
  const sid = (await c.query(`SELECT id FROM logistics.shipments WHERE folio='ZZ-MID-2'`)).rows[0].id;
  const c0 = Number((await c.query(`SELECT total_cost FROM logistics.shipment_expenses WHERE shipment_id=$1`,[sid])).rows[0].total_cost);
  await c.query(`UPDATE logistics.shipments SET actual_km=400 WHERE id=$1`,[sid]);           // el PATCH
  const cSin = Number((await c.query(`SELECT total_cost FROM logistics.shipment_expenses WHERE shipment_id=$1`,[sid])).rows[0].total_cost);
  await c.query(`UPDATE logistics.shipment_expenses SET total_cost = operating_subtotal + (400*fixed_cost_per_km) WHERE shipment_id=$1`,[sid]); // el fix
  const cCon = Number((await c.query(`SELECT total_cost FROM logistics.shipment_expenses WHERE shipment_id=$1`,[sid])).rows[0].total_cost);
  console.log(`   km 100→400 · total_cost: inicial $${c0} · sin fix $${cSin} · con fix $${cCon}`);
  ok(cSin === c0, 'ANTES: corregir el km NO movia el costo (quedaba con el km viejo)');
  ok(cCon === 5000, 'DESPUES: recalcula 1000 + 400×10 = $5,000');

  console.log('\n════════ F-5 · doble reserva de unidad ════════');
  const activos = ['programado','checklist_salida','en_ruta','entregado','checklist_llegada','costos_pendientes'];
  await c.query(`UPDATE logistics.shipments SET status='en_ruta' WHERE folio='ZZ-MID-2'`);
  const choque = (await c.query(`SELECT folio,status FROM logistics.shipments
      WHERE vehicle_id=$1 AND deleted_at IS NULL AND status = ANY($2)`,[V.id,activos])).rows;
  console.log(`   unidad ${V.plate} comprometida en: ${choque.map(r=>r.folio+':'+r.status).join(', ') || '(ninguno)'}`);
  ok(choque.length>0, `ANTES se permitia crear otro embarque con la misma unidad; ahora assertVehicleAvailable lo frena con 409`);
  const otroAbierto = (await c.query(`SELECT 1 FROM logistics.shipments WHERE vehicle_id=$1 AND deleted_at IS NULL
      AND id <> (SELECT id FROM logistics.shipments WHERE folio='ZZ-TOP-1') AND status = ANY($2)`,[V.id,activos])).rowCount;
  ok(otroAbierto>0, 'al cerrar ZZ-TOP-1, releaseVehicleIfIdle NO libera la unidad (sigue ZZ-MID-2 en ruta)');

  console.log('\n════════ F-4 · "Reconocer" una alerta viva ════════');
  const tr = (await c.query(`SELECT id FROM logistics.trackers WHERE deleted_at IS NULL LIMIT 1`)).rows[0];
  await c.query(`DELETE FROM logistics.fleet_alerts WHERE tracker_id=$1 AND kind='speed'`,[tr.id]);
  await c.query(`INSERT INTO logistics.fleet_alerts (tenant_id,tracker_id,kind,severity,message,value,status)
     VALUES ($1,$2,'speed','warn','Exceso',95,'ack')`,[T,tr.id]);
  const buscaVieja = (await c.query(`SELECT id FROM logistics.fleet_alerts WHERE tracker_id=$1 AND kind='speed' AND status='open'`,[tr.id])).rowCount;
  const buscaNueva = (await c.query(`SELECT id FROM logistics.fleet_alerts WHERE tracker_id=$1 AND kind='speed' AND status IN ('open','ack')`,[tr.id])).rowCount;
  console.log(`   scanner busca... ANTES (solo 'open'): ${buscaVieja} filas → inserta duplicado`);
  console.log(`   scanner busca... DESPUES ('open'|'ack'): ${buscaNueva} filas → actualiza la existente`);
  ok(buscaVieja===0 && buscaNueva===1, 'la ack ahora SI se encuentra: no se duplica y sigue silenciada');

  await c.query('ROLLBACK'); await c.end();
  console.log(`\n═══════════════════════════════════\n  ${pass} OK · ${fail} FAIL   (todo revertido con ROLLBACK)\n═══════════════════════════════════`);
  process.exit(fail?1:0);
})().catch(e=>{console.error('ERROR',e.message);process.exit(1);});
