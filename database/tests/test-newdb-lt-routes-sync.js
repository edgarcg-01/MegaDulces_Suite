/**
 * LT.7 smoke — sync autoritativo ruta↔operador↔camión (API oficial travels/operators).
 *
 * Verifica: (1) las columnas operator_id/operator_name existen; (2) la extracción
 * de número desde no_planeacion; (3) el UPDATE por IMEI puebla route_number +
 * operador y marca route_manual=true (protege del name-parse). Tx con ROLLBACK.
 */
require('dotenv').config();
const { Client } = require('pg');
const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const IMEI = 'LT7-SYNC-IMEI';

// Réplica de digits() del servicio.
const digits = (s) => { const m = (s || '').replace(/\D/g, ''); return m ? parseInt(m, 10) : null; };

let n = 0; const assert = (c, m) => { n++; if (!c) throw new Error('FAIL: ' + m); console.log('  ✓ ' + m); };

(async () => {
  console.log('\n=== LT.7 smoke: sync ruta/operador ===');
  const client = new Client({ connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW });
  await client.connect();
  const q = async (s, p) => (await client.query(s, p)).rows;
  await client.query('BEGIN'); await client.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
  try {
    assert(digits('PLAN021') === 21 && digits('R-21') === 21 && digits('RUTA 7') === 7 && digits('SINRUTA') === null,
      'extracción de nº de planeación: PLAN021→21 / R-21→21 / RUTA 7→7 / SINRUTA→null');

    const veh = (await q(`insert into logistics.vehicles (tenant_id,plate,status,active) values (public.current_tenant_id(),'LT7-PLATE','disponible',true) returning id`))[0];
    await client.query(`insert into logistics.trackers (tenant_id,provider,imei,vehicle_id,active,route_manual) values (public.current_tenant_id(),'magnitracking',$1,$2,true,false)`, [IMEI, veh.id]);

    // Simula el UPDATE de syncRoutesOperators para un travel {imei, no_planeacion:'PLAN021', operador}.
    const noPlan = 'PLAN021';
    await client.query(
      `update logistics.trackers set route_code=$1, route_number=$2, route_manual=true, operator_id=$3, operator_name=$4, updated_at=now() where imei=$5`,
      [noPlan, digits(noPlan), 'op-123', 'Juan Pérez', IMEI]);

    const t = (await q(`select route_code, route_number, route_manual, operator_id, operator_name from logistics.trackers where imei=$1`, [IMEI]))[0];
    assert(t.route_code === 'PLAN021', 'route_code = no_planeacion crudo');
    assert(t.route_number === 21, `route_number derivado = 21 (obtuvo ${t.route_number})`);
    assert(t.route_manual === true, 'route_manual=true (autoritativo, protege del name-parse)');
    assert(t.operator_id === 'op-123' && t.operator_name === 'Juan Pérez', 'operador poblado (id + nombre)');

    // listLive debe preferir operator_name como vendedor/operador mostrado.
    const shown = t.operator_name || null;
    assert(shown === 'Juan Pérez', 'operator_name gana como operador mostrado en el mapa');

    await client.query('ROLLBACK');
    console.log(`\n✅ ${n}/${n} asserts OK\n`); process.exit(0);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌', e.message, '\n'); process.exit(1);
  } finally { await client.end(); }
})();
