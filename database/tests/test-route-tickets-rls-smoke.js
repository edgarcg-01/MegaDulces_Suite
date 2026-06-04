#!/usr/bin/env node
/**
 * Smoke RLS para commercial.route_tickets ("Cierre de ruta").
 *
 * Verifica:
 *   1. Aislamiento por tenant (A no ve los de B y viceversa).
 *   2. Sin contexto → 0 filas (RLS forzado).
 *   3. INSERT cross-tenant rechazado (WITH CHECK).
 *   4. Unique parcial de corte_number (mismo tenant) + múltiples NULL (carga).
 *
 * Correr: node database/test-route-tickets-rls-smoke.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const adminUrl = process.env.DATABASE_URL_NEW;
const runtimeUrl = process.env.DATABASE_URL_NEW_RUNTIME
  || adminUrl.replace('postgres:superoot', 'app_runtime:app_runtime');

const TENANT_A = '00000000-0000-0000-0000-00000000d01c';
const TENANT_B = '00000000-0000-0000-0000-00000000beef';
const VENDOR = '00000000-0000-0000-0000-0000000000aa'; // uuid arbitrario (sin FK a users-view)

let pass = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`, extra ?? ''); fail++; }
}

async function withTenant(client, tenantId, fn) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  try { const r = await fn(); await client.query('COMMIT'); return r; }
  catch (e) { await client.query('ROLLBACK'); throw e; }
}

(async () => {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const app = new Client({ connectionString: runtimeUrl });
  await app.connect();
  try {
    console.log('═══ route_tickets RLS smoke ═══\n');
    await admin.query(`INSERT INTO tenants (id, slug, nombre, plan) VALUES ('${TENANT_B}','test_tenant_b','Test Tenant B','standard') ON CONFLICT (slug) DO NOTHING`);

    // limpieza previa
    await admin.query(`DELETE FROM commercial.route_tickets WHERE route_code IN ('SMK-A','SMK-B')`);

    // Test 1: inserts por tenant
    const RC = 'SMK-A';
    await withTenant(app, TENANT_A, async () => {
      await app.query(`INSERT INTO commercial.route_tickets (tenant_id, vendor_user_id, ticket_type, route_code, ticket_date, total) VALUES (current_tenant_id(), '${VENDOR}', 'venta', '${RC}', '2026-06-03', 1000)`);
    });
    await withTenant(app, TENANT_B, async () => {
      await app.query(`INSERT INTO commercial.route_tickets (tenant_id, vendor_user_id, ticket_type, route_code, ticket_date, total) VALUES (current_tenant_id(), '${VENDOR}', 'venta', 'SMK-B', '2026-06-03', 2000)`);
    });

    const aSees = await withTenant(app, TENANT_A, async () =>
      (await app.query(`SELECT route_code FROM commercial.route_tickets WHERE route_code LIKE 'SMK-%'`)).rows.map(r => r.route_code));
    assert(aSees.includes('SMK-A'), 'Tenant A ve su ticket SMK-A');
    assert(!aSees.includes('SMK-B'), 'Tenant A NO ve el ticket de B', aSees);

    const bSees = await withTenant(app, TENANT_B, async () =>
      (await app.query(`SELECT route_code FROM commercial.route_tickets WHERE route_code LIKE 'SMK-%'`)).rows.map(r => r.route_code));
    assert(bSees.includes('SMK-B') && !bSees.includes('SMK-A'), 'Tenant B ve solo el suyo', bSees);

    // Test 2: sin contexto → 0
    const noCtx = (await app.query(`SELECT count(*)::int AS c FROM commercial.route_tickets`)).rows[0].c;
    assert(noCtx === 0, 'Sin contexto, count = 0', noCtx);

    // Test 3: INSERT cross-tenant rechazado
    let rejected = false;
    try {
      await withTenant(app, TENANT_A, async () => {
        await app.query(`INSERT INTO commercial.route_tickets (tenant_id, vendor_user_id, ticket_type, route_code, ticket_date) VALUES ('${TENANT_B}', '${VENDOR}', 'venta', 'SMK-X', '2026-06-03')`);
      });
    } catch { rejected = true; }
    assert(rejected, 'INSERT con tenant_id de B bajo contexto A rechazado (WITH CHECK)');

    // Test 4: unique parcial de corte_number + NULL múltiple (carga)
    let dupRejected = false;
    try {
      await withTenant(app, TENANT_A, async () => {
        await app.query(`INSERT INTO commercial.route_tickets (tenant_id, vendor_user_id, ticket_type, route_code, ticket_date, corte_number) VALUES (current_tenant_id(), '${VENDOR}', 'venta', 'SMK-A', '2026-06-03', 'CORTE-DUP')`);
        await app.query(`INSERT INTO commercial.route_tickets (tenant_id, vendor_user_id, ticket_type, route_code, ticket_date, corte_number) VALUES (current_tenant_id(), '${VENDOR}', 'venta', 'SMK-A', '2026-06-03', 'CORTE-DUP')`);
      });
    } catch { dupRejected = true; }
    assert(dupRejected, 'corte_number duplicado (mismo tenant) rechazado');

    let nullsOk = true;
    try {
      await withTenant(app, TENANT_A, async () => {
        await app.query(`INSERT INTO commercial.route_tickets (tenant_id, vendor_user_id, ticket_type, route_code, ticket_date) VALUES (current_tenant_id(), '${VENDOR}', 'carga', 'SMK-A', '2026-06-03')`);
        await app.query(`INSERT INTO commercial.route_tickets (tenant_id, vendor_user_id, ticket_type, route_code, ticket_date) VALUES (current_tenant_id(), '${VENDOR}', 'carga', 'SMK-A', '2026-06-03')`);
      });
    } catch (e) { nullsOk = false; }
    assert(nullsOk, 'Múltiples cargas con corte_number NULL permitidas');

    // cleanup
    await admin.query(`DELETE FROM commercial.route_tickets WHERE route_code IN ('SMK-A','SMK-B')`);

    console.log(`\n═══ Resultado: ${pass} pass / ${fail} fail ═══`);
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    await admin.end();
    await app.end();
  }
})().catch((e) => { console.error('Excepción:', e.message); process.exit(1); });
