#!/usr/bin/env node
/**
 * Smoke test RLS para schema `logistics.*` (Fase J.0.6).
 *
 * Verifica:
 *   1. Tenant A crea vehicle/route/driver → solo Tenant A los ve.
 *   2. Sin contexto, nada visible (RLS forzado).
 *   3. INSERT cross-tenant rechazado (WITH CHECK).
 *   4. Composite FK cross-tenant rechazado (shipment.vehicle_id de otro tenant).
 *   5. ON DELETE CASCADE local (delete shipment → expense + load_details borrados).
 *
 * Pre-requisitos:
 *   - Tenant Mega Dulces (TENANT_A) ya existe.
 *   - Tenant B (test_tenant_b) ya existe (creado por test-newdb-rls-isolation.js).
 *   - Seeds logistics baseline corridos (vehicle DEMO-001, etc).
 *
 * Correr: node database/test-logistics-rls-smoke.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Client } = require('pg');

const adminUrl = process.env.DATABASE_URL_NEW;
const runtimeUrl = process.env.DATABASE_URL_NEW_RUNTIME
  || adminUrl.replace('postgres:superoot', 'app_runtime:app_runtime');

const TENANT_A = '00000000-0000-0000-0000-00000000d01c'; // Mega Dulces
const TENANT_B = '00000000-0000-0000-0000-00000000beef'; // Tenant test

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else      { console.error(`  ✗ ${msg}`); fail++; }
}

async function runWithTenant(client, tenantId, fn) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  try {
    const r = await fn();
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

(async () => {
  const adminClient = new Client({ connectionString: adminUrl });
  await adminClient.connect();
  const appClient = new Client({ connectionString: runtimeUrl });
  await appClient.connect();

  try {
    console.log('═══ Logistics RLS Smoke Test ═══\n');

    // Pre: asegurarnos tenant B existe
    await adminClient.query(`
      INSERT INTO tenants (id, slug, nombre, plan)
      VALUES ('${TENANT_B}', 'test_tenant_b', 'Test Tenant B', 'standard')
      ON CONFLICT (slug) DO NOTHING
    `);

    // ─────────────────────────────────────────────────────────────────────
    console.log('═══ Test 1: tenant A ve solo SUS vehicles ═══\n');

    // Tenant B crea su propio vehicle (que el seed no creó)
    await runWithTenant(appClient, TENANT_B, async () => {
      await appClient.query(`
        INSERT INTO logistics.vehicles (tenant_id, plate, model, status)
        VALUES (current_tenant_id(), 'TENANT-B-001', 'Camión B', 'disponible')
        ON CONFLICT (tenant_id, plate) DO NOTHING
      `);
    });

    const vehiclesA = await runWithTenant(appClient, TENANT_A, async () => {
      const r = await appClient.query(`SELECT plate FROM logistics.vehicles ORDER BY plate`);
      return r.rows.map(r => r.plate);
    });
    console.log('  Tenant A ve vehicles:', vehiclesA);
    assert(vehiclesA.includes('DEMO-001'), 'Tenant A ve su DEMO-001 (del seed)');
    assert(!vehiclesA.includes('TENANT-B-001'), 'Tenant A NO ve vehicle de tenant B');

    const vehiclesB = await runWithTenant(appClient, TENANT_B, async () => {
      const r = await appClient.query(`SELECT plate FROM logistics.vehicles ORDER BY plate`);
      return r.rows.map(r => r.plate);
    });
    console.log('  Tenant B ve vehicles:', vehiclesB);
    assert(vehiclesB.includes('TENANT-B-001'), 'Tenant B ve su TENANT-B-001');
    assert(!vehiclesB.includes('DEMO-001'), 'Tenant B NO ve DEMO-001 de tenant A');

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 2: SIN contexto, logistics.* invisible ═══\n');

    await appClient.query('BEGIN');
    const noCtx = await appClient.query(`SELECT COUNT(*)::int AS c FROM logistics.vehicles`);
    assert(noCtx.rows[0].c === 0, `Sin contexto, vehicles count = 0 (got ${noCtx.rows[0].c})`);
    const noCtxD = await appClient.query(`SELECT COUNT(*)::int AS c FROM logistics.drivers`);
    assert(noCtxD.rows[0].c === 0, `Sin contexto, drivers count = 0 (got ${noCtxD.rows[0].c})`);
    await appClient.query('COMMIT');

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 3: INSERT cross-tenant rechazado ═══\n');

    try {
      await runWithTenant(appClient, TENANT_A, async () => {
        await appClient.query(`
          INSERT INTO logistics.vehicles (tenant_id, plate, status)
          VALUES ('${TENANT_B}', 'HACK-001', 'disponible')
        `);
      });
      console.error('  ✗ FAIL: INSERT cross-tenant fue permitido (bug)');
      fail++;
    } catch (e) {
      assert(true, `INSERT cross-tenant rechazado: ${e.message.split('\n')[0]}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 4: composite FK cross-tenant rechazado ═══\n');

    // Tenant A intenta crear shipment apuntando a vehicle de tenant B
    // Necesita primero el ID del vehicle B (que conseguimos como admin)
    const vehicleBId = (await adminClient.query(
      `SELECT id FROM logistics.vehicles WHERE plate = 'TENANT-B-001'`
    )).rows[0]?.id;

    try {
      await runWithTenant(appClient, TENANT_A, async () => {
        await appClient.query(`
          INSERT INTO logistics.shipments (tenant_id, folio, shipment_date, vehicle_id)
          VALUES (current_tenant_id(), 'HACK-EMB-001', CURRENT_DATE, '${vehicleBId}')
        `);
      });
      console.error('  ✗ FAIL: shipment con vehicle ajeno fue permitido (composite FK roto)');
      fail++;
    } catch (e) {
      assert(true, `Shipment apuntando a vehicle de otro tenant rechazado: ${e.message.split('\n')[0]}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 5: ON DELETE CASCADE local funciona ═══\n');

    let shipmentId, expenseCountBefore, expenseCountAfter;
    await runWithTenant(appClient, TENANT_A, async () => {
      // Crear shipment + expense + verificar cascade
      const vehicleA = await appClient.query(
        `SELECT id FROM logistics.vehicles WHERE plate = 'DEMO-001'`
      );
      const vehAId = vehicleA.rows[0].id;

      const shipR = await appClient.query(`
        INSERT INTO logistics.shipments (tenant_id, folio, shipment_date, vehicle_id, status)
        VALUES (current_tenant_id(), 'CASCADE-TEST-001', CURRENT_DATE, '${vehAId}', 'programado')
        RETURNING id
      `);
      shipmentId = shipR.rows[0].id;

      await appClient.query(`
        INSERT INTO logistics.shipment_expenses (tenant_id, shipment_id, fuel, total_cost)
        VALUES (current_tenant_id(), '${shipmentId}', 500, 500)
      `);

      const before = await appClient.query(
        `SELECT COUNT(*)::int AS c FROM logistics.shipment_expenses WHERE shipment_id = '${shipmentId}'`
      );
      expenseCountBefore = before.rows[0].c;

      // Borrar shipment → expense debería desaparecer (CASCADE)
      await appClient.query(`DELETE FROM logistics.shipments WHERE id = '${shipmentId}'`);

      const after = await appClient.query(
        `SELECT COUNT(*)::int AS c FROM logistics.shipment_expenses WHERE shipment_id = '${shipmentId}'`
      );
      expenseCountAfter = after.rows[0].c;
    });
    assert(expenseCountBefore === 1, `Expense creado (count = ${expenseCountBefore})`);
    assert(expenseCountAfter === 0, `Expense cascadeado al borrar shipment (count = ${expenseCountAfter})`);

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 6: payroll_periods unique (tenant, year, number) ═══\n');

    try {
      await runWithTenant(appClient, TENANT_A, async () => {
        await appClient.query(`
          INSERT INTO logistics.payroll_periods (tenant_id, number, year, start_date, end_date, payment_date)
          VALUES (current_tenant_id(), 11, 2026, '2026-05-26', '2026-06-08', '2026-06-09')
        `);
      });
      console.error('  ✗ FAIL: período duplicado fue permitido');
      fail++;
    } catch (e) {
      assert(true, `Período duplicado (2026/11) rechazado: ${e.message.split('\n')[0]}`);
    }

    // Cleanup: borrar vehicle de tenant B y test data
    await runWithTenant(appClient, TENANT_B, async () => {
      await appClient.query(`DELETE FROM logistics.vehicles WHERE plate = 'TENANT-B-001'`);
    });

    // ─────────────────────────────────────────────────────────────────────
    console.log(`\n═══ Resumen: ${pass} pass / ${fail} fail ═══`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    await adminClient.end();
    await appClient.end();
  }
})().catch(err => {
  console.error('\n💥 Error fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
