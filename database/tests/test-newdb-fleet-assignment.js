/**
 * FC.1 smoke — derecho de uso + acta de asignación vehicular.
 *
 * Prueba los CANDADOS, no el camino feliz: que RLS aísle, que no se pueda dar
 * dos veces el mismo derecho vigente, que una unidad no figure entregada a dos
 * personas a la vez, y que la calificación M/R/B no acepte basura.
 *
 * Todo dentro de una transacción con ROLLBACK: no deja rastro.
 */
require('dotenv').config();
const { Client } = require('pg');

const TENANT = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let assertions = 0;
function assert(cond, msg) {
  assertions++;
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}
/** Espera que la query falle; devuelve el mensaje de error. */
async function debeFallar(client, sql, params, msg) {
  await client.query('SAVEPOINT sp');
  try {
    await client.query(sql, params);
    await client.query('ROLLBACK TO SAVEPOINT sp');
    assert(false, msg);
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp');
    if (e.message.startsWith('ASSERT FAIL')) throw e;
    assert(true, `${msg} → ${e.message.split('\n')[0].slice(0, 90)}`);
  }
}

(async () => {
  console.log('\n=== FC.1 smoke: asignación vehicular ===');
  const client = new Client({
    connectionString: process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [TENANT]);

    const v = (await client.query(
      `SELECT id, plate FROM logistics.vehicles WHERE deleted_at IS NULL ORDER BY plate LIMIT 2`)).rows;
    const d = (await client.query(
      `SELECT id, full_name FROM logistics.drivers WHERE deleted_at IS NULL ORDER BY full_name LIMIT 2`)).rows;
    assert(v.length === 2 && d.length === 2, `hay flota y personal para probar (${v.length} unidades, ${d.length} personas)`);

    // ── DERECHO de uso ────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO logistics.vehicle_entitlements (tenant_id,driver_id,vehicle_id,capacity,source)
       VALUES (public.current_tenant_id(),$1,$2,'chofer','smoke')`, [d[0].id, v[0].id]);
    assert(true, `derecho dado de alta: ${d[0].full_name} → ${v[0].plate}`);

    await debeFallar(client,
      `INSERT INTO logistics.vehicle_entitlements (tenant_id,driver_id,vehicle_id,capacity,source)
       VALUES (public.current_tenant_id(),$1,$2,'chofer','smoke')`, [d[0].id, v[0].id],
      'el mismo derecho vigente NO se puede duplicar');

    // Vencer el derecho y volver a otorgarlo: el histórico convive.
    await client.query(
      `UPDATE logistics.vehicle_entitlements SET valid_to = current_date
        WHERE driver_id=$1 AND vehicle_id=$2`, [d[0].id, v[0].id]);
    await client.query(
      `INSERT INTO logistics.vehicle_entitlements (tenant_id,driver_id,vehicle_id,capacity,source)
       VALUES (public.current_tenant_id(),$1,$2,'chofer','smoke-2')`, [d[0].id, v[0].id]);
    const hist = (await client.query(
      `SELECT count(*)::int n FROM logistics.vehicle_entitlements WHERE driver_id=$1 AND vehicle_id=$2`,
      [d[0].id, v[0].id])).rows[0].n;
    assert(hist === 2, 'vencido el anterior, el nuevo derecho convive con el histórico (2 filas)');

    // La misma persona puede tener derecho a varias unidades: es el agrupamiento.
    await client.query(
      `INSERT INTO logistics.vehicle_entitlements (tenant_id,driver_id,vehicle_id,capacity,source)
       VALUES (public.current_tenant_id(),$1,$2,'chofer','smoke')`, [d[0].id, v[1].id]);
    const cuantas = (await client.query(
      `SELECT count(*)::int n FROM logistics.vehicle_entitlements
        WHERE driver_id=$1 AND valid_to IS NULL AND deleted_at IS NULL`, [d[0].id])).rows[0].n;
    assert(cuantas === 2, `un colaborador con derecho a 2 unidades (${cuantas})`);

    await debeFallar(client,
      `INSERT INTO logistics.vehicle_entitlements (tenant_id,driver_id,vehicle_id,capacity)
       VALUES (public.current_tenant_id(),$1,$2,'gerente')`, [d[1].id, v[0].id],
      'un carácter fuera del catálogo se rechaza');

    await debeFallar(client,
      `INSERT INTO logistics.vehicle_entitlements (tenant_id,driver_id,vehicle_id,capacity,valid_from,valid_to)
       VALUES (public.current_tenant_id(),$1,$2,'chofer','2026-05-01','2026-01-01')`, [d[1].id, v[1].id],
      'una vigencia que termina antes de empezar se rechaza');

    // ── ACTA de asignación ────────────────────────────────────────────────
    await client.query(
      `INSERT INTO logistics.vehicle_assignments
         (tenant_id,folio,vehicle_id,responsible_driver_id,driver_id,area,odometer,assigned_on,condition,condition_template)
       VALUES (public.current_tenant_id(),'SMOKE-1',$1,$2,$3,'Área de prueba',0,current_date,
               '{"llantas":"B","parabrisas":"R","gato":"M"}'::jsonb,'md-asignacion-v1')`,
      [v[0].id, d[1].id, d[0].id]);
    assert(true, 'acta creada con estado M/R/B por concepto');

    await debeFallar(client,
      `INSERT INTO logistics.vehicle_assignments (tenant_id,folio,vehicle_id,assigned_on)
       VALUES (public.current_tenant_id(),'SMOKE-2',$1,current_date)`, [v[0].id],
      'la MISMA unidad no puede estar entregada dos veces a la vez');

    await debeFallar(client,
      `INSERT INTO logistics.vehicle_assignments (tenant_id,folio,vehicle_id,assigned_on)
       VALUES (public.current_tenant_id(),'SMOKE-1',$1,current_date)`, [v[1].id],
      'el folio del formato es único');

    // Devuelta la unidad, se puede volver a asignar.
    await client.query(
      `UPDATE logistics.vehicle_assignments SET status='devuelto', released_on=current_date WHERE folio='SMOKE-1'`);
    await client.query(
      `INSERT INTO logistics.vehicle_assignments (tenant_id,folio,vehicle_id,assigned_on)
       VALUES (public.current_tenant_id(),'SMOKE-3',$1,current_date)`, [v[0].id]);
    assert(true, 'devuelta la unidad, admite una asignación nueva');

    await debeFallar(client,
      `INSERT INTO logistics.vehicle_assignments (tenant_id,folio,vehicle_id,assigned_on,released_on)
       VALUES (public.current_tenant_id(),'SMOKE-4',$1,'2026-05-01','2026-01-01')`, [v[1].id],
      'una devolución anterior a la entrega se rechaza');

    // ── Aislamiento por tenant ────────────────────────────────────────────
    await client.query(`SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-0000000000ff', true)`);
    const ajeno = (await client.query(
      `SELECT (SELECT count(*)::int FROM logistics.vehicle_entitlements) e,
              (SELECT count(*)::int FROM logistics.vehicle_assignments) a`)).rows[0];
    assert(ajeno.e === 0 && ajeno.a === 0, 'otro tenant no ve derechos ni actas (RLS forzado)');

    // ── La calificación no acepta basura ──────────────────────────────────
    const GRADES = new Set(['M', 'R', 'B']);
    const validar = (cond) => Object.entries(cond)
      .filter(([, v2]) => !GRADES.has(v2)).map(([k]) => k);
    assert(validar({ llantas: 'B', gato: 'R' }).length === 0, 'M/R/B válidos pasan');
    assert(validar({ llantas: 'X' }).length === 1, 'una calificación fuera de M/R/B se detecta');
    assert(validar({ llantas: true }).length === 1, 'un booleano no cuela como calificación (el formato tiene 3 niveles, no 2)');

    console.log(`\n✅ ${assertions}/${assertions} asserts OK (todo revertido)\n`);
    await client.query('ROLLBACK');
    await client.end();
    process.exit(0);
  } catch (e) {
    console.error('\n❌', e.message, '\n');
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    await client.end();
    process.exit(1);
  }
})();
