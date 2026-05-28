#!/usr/bin/env node
/**
 * Test E2E de aislamiento RLS entre tenants.
 *
 * Setup:
 *   1. Crea un tenant secundario "tenant_b" además del Mega Dulces.
 *   2. Crea data en cada tenant (zone, role, user, store, visit, etc.).
 *   3. Verifica que cada tenant SOLO ve su propia data (RLS funciona).
 *   4. Verifica que INSERT/UPDATE cross-tenant FALLA (WITH CHECK funciona).
 *   5. Verifica que SIN contexto, nada es visible.
 *   6. Cleanup.
 *
 * IMPORTANTE: corre como `app_runtime` (no postgres) para que RLS aplique.
 *
 * Correr: node database/test-newdb-rls-isolation.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Client } = require('pg');

// Usa el runtime URL (app_runtime)
const url = process.env.DATABASE_URL_NEW_RUNTIME
  || process.env.DATABASE_URL_NEW.replace('postgres:superoot', 'app_runtime:app_runtime');

const TENANT_A = '00000000-0000-0000-0000-00000000d01c'; // Mega Dulces (existente)
const TENANT_B = '00000000-0000-0000-0000-00000000beef'; // Tenant secundario para test

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else      { console.error(`  ✗ ${msg}`); fail++; }
}

async function runWithTenant(client, tenantId, fn) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

(async () => {
  // Conexión como postgres (necesario para CREAR el tenant B — bypass RLS)
  const adminClient = new Client({ connectionString: process.env.DATABASE_URL_NEW });
  await adminClient.connect();

  // Conexión como app_runtime (sujeto a RLS)
  const appClient = new Client({ connectionString: url });
  await appClient.connect();

  try {
    console.log('═══ Setup ═══\n');

    // 1. Crear tenant B como postgres (bypassea RLS)
    await adminClient.query(`
      INSERT INTO tenants (id, slug, nombre, plan)
      VALUES ('${TENANT_B}', 'test_tenant_b', 'Test Tenant B', 'standard')
      ON CONFLICT (slug) DO NOTHING
    `);
    console.log(`  ✓ Tenant B creado (${TENANT_B})`);

    // 2. Crear data en cada tenant via app_runtime con su contexto
    console.log('\n═══ Crear data en cada tenant ═══\n');

    await runWithTenant(appClient, TENANT_A, async () => {
      await appClient.query(`
        INSERT INTO zones (tenant_id, name, orden)
        VALUES (current_tenant_id(), 'ZONA_A_TEST', 100)
        ON CONFLICT (tenant_id, name) DO NOTHING
      `);
    });
    console.log('  ✓ Zone "ZONA_A_TEST" creada en tenant A');

    await runWithTenant(appClient, TENANT_B, async () => {
      // Tenant B necesita rol propio antes de crear user (FK lo requiere)
      await appClient.query(`
        INSERT INTO role_permissions (tenant_id, role_name, permissions)
        VALUES (current_tenant_id(), 'admin_b', '{"USUARIOS_VER":true}')
        ON CONFLICT (tenant_id, role_name) DO NOTHING
      `);
      await appClient.query(`
        INSERT INTO zones (tenant_id, name, orden)
        VALUES (current_tenant_id(), 'ZONA_B_TEST', 200)
        ON CONFLICT (tenant_id, name) DO NOTHING
      `);
    });
    console.log('  ✓ Role "admin_b" + Zone "ZONA_B_TEST" creadas en tenant B');

    // ─────────────────────────────────────────────────────────────────────
    // TESTS DE AISLAMIENTO
    // ─────────────────────────────────────────────────────────────────────

    console.log('\n═══ Test 1: cada tenant solo ve sus zones ═══\n');

    const zonesA = await runWithTenant(appClient, TENANT_A, async () => {
      const r = await appClient.query(`SELECT name FROM zones`);
      return r.rows.map(r => r.name);
    });
    console.log('  Tenant A ve zones:', zonesA);
    assert(zonesA.includes('ZONA_A_TEST'), 'Tenant A ve su zona ZONA_A_TEST');
    assert(!zonesA.includes('ZONA_B_TEST'), 'Tenant A NO ve zona de tenant B');

    const zonesB = await runWithTenant(appClient, TENANT_B, async () => {
      const r = await appClient.query(`SELECT name FROM zones`);
      return r.rows.map(r => r.name);
    });
    console.log('  Tenant B ve zones:', zonesB);
    assert(zonesB.includes('ZONA_B_TEST'), 'Tenant B ve su zona ZONA_B_TEST');
    assert(!zonesB.includes('ZONA_A_TEST'), 'Tenant B NO ve zona de tenant A');

    console.log('\n═══ Test 2: cada tenant solo ve sus roles ═══\n');

    const rolesA = await runWithTenant(appClient, TENANT_A, async () => {
      const r = await appClient.query(`SELECT role_name FROM role_permissions ORDER BY role_name`);
      return r.rows.map(r => r.role_name);
    });
    console.log('  Tenant A ve roles:', rolesA);
    assert(rolesA.includes('superadmin'), 'Tenant A ve su rol superadmin');
    assert(!rolesA.includes('admin_b'), 'Tenant A NO ve rol "admin_b" de tenant B');

    const rolesB = await runWithTenant(appClient, TENANT_B, async () => {
      const r = await appClient.query(`SELECT role_name FROM role_permissions ORDER BY role_name`);
      return r.rows.map(r => r.role_name);
    });
    console.log('  Tenant B ve roles:', rolesB);
    assert(rolesB.includes('admin_b'), 'Tenant B ve su rol admin_b');
    assert(!rolesB.includes('superadmin'), 'Tenant B NO ve rol "superadmin" de tenant A');

    console.log('\n═══ Test 3: cada tenant solo ve sus users ═══\n');

    const usersA = await runWithTenant(appClient, TENANT_A, async () => {
      const r = await appClient.query(`SELECT username FROM users`);
      return r.rows.map(r => r.username);
    });
    console.log('  Tenant A ve users:', usersA);
    assert(usersA.includes('superoot'), 'Tenant A ve a superoot');

    const usersB = await runWithTenant(appClient, TENANT_B, async () => {
      const r = await appClient.query(`SELECT username FROM users`);
      return r.rows.map(r => r.username);
    });
    console.log('  Tenant B ve users:', usersB);
    assert(!usersB.includes('superoot'), 'Tenant B NO ve a superoot (es del tenant A)');

    console.log('\n═══ Test 4: SIN contexto, nada es visible ═══\n');

    await appClient.query('BEGIN');
    const noCtx = await appClient.query(`SELECT COUNT(*)::int AS c FROM users`);
    assert(noCtx.rows[0].c === 0, `Sin contexto, users count = 0 (got ${noCtx.rows[0].c})`);

    const noCtxZ = await appClient.query(`SELECT COUNT(*)::int AS c FROM zones`);
    assert(noCtxZ.rows[0].c === 0, `Sin contexto, zones count = 0 (got ${noCtxZ.rows[0].c})`);
    await appClient.query('COMMIT');

    console.log('\n═══ Test 5: INSERT cross-tenant rechazado (WITH CHECK) ═══\n');

    try {
      await runWithTenant(appClient, TENANT_A, async () => {
        await appClient.query(`
          INSERT INTO zones (tenant_id, name) VALUES ('${TENANT_B}', 'HACK_ZONE')
        `);
      });
      console.error('  ✗ FAIL: INSERT cross-tenant fue PERMITIDO (bug)');
      fail++;
    } catch (e) {
      assert(true, `INSERT cross-tenant rechazado: ${e.message.split('\n')[0]}`);
    }

    console.log('\n═══ Test 6: UPDATE cross-tenant rechazado ═══\n');

    // Intentar update de zona de tenant B mientras estoy en contexto A
    // RLS filtra SELECT así que el UPDATE no encuentra rows (returning 0 updated)
    const updatedRows = await runWithTenant(appClient, TENANT_A, async () => {
      const r = await appClient.query(`UPDATE zones SET orden = 999 WHERE name = 'ZONA_B_TEST'`);
      return r.rowCount;
    });
    assert(updatedRows === 0, `UPDATE de zona ajena tocó 0 rows (got ${updatedRows})`);

    // Verificar que zona B sigue intacta
    const zbOrden = await runWithTenant(appClient, TENANT_B, async () => {
      const r = await appClient.query(`SELECT orden FROM zones WHERE name = 'ZONA_B_TEST'`);
      return r.rows[0]?.orden;
    });
    assert(Number(zbOrden) === 200, `Zona B mantiene su orden original (got ${zbOrden})`);

    console.log('\n═══ Test 7: composite FK cross-tenant rechazado ═══\n');

    try {
      await runWithTenant(appClient, TENANT_A, async () => {
        // Intentar insertar user con role_name de otro tenant (admin_b)
        await appClient.query(`
          INSERT INTO users (tenant_id, username, password_hash, role_name)
          VALUES (current_tenant_id(), 'hacker', 'hash', 'admin_b')
        `);
      });
      console.error('  ✗ FAIL: User con role de otro tenant fue creado (bug)');
      fail++;
    } catch (e) {
      assert(true, `User con role cross-tenant rechazado: ${e.message.split('\n')[0].substring(0, 80)}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Cleanup
    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Cleanup ═══\n');

    // Borrar data de tenant B (como postgres para evitar RLS issues con FKs)
    await adminClient.query(`DELETE FROM zones WHERE name IN ('ZONA_B_TEST') AND tenant_id = '${TENANT_B}'`);
    await adminClient.query(`DELETE FROM zones WHERE name = 'ZONA_A_TEST' AND tenant_id = '${TENANT_A}'`);
    await adminClient.query(`DELETE FROM role_permissions WHERE role_name = 'admin_b' AND tenant_id = '${TENANT_B}'`);
    await adminClient.query(`DELETE FROM tenants WHERE id = '${TENANT_B}'`);
    console.log('  ✓ Data de test eliminada');

    console.log(`\n═══════════ Resultado: ${pass} pass / ${fail} fail ═══════════`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error('\n✗ Excepción inesperada:', err.message);
    console.error(err.stack);
    process.exit(2);
  } finally {
    await appClient.end();
    await adminClient.end();
  }
})();
