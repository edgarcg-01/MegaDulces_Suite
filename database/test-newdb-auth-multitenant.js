#!/usr/bin/env node
/**
 * Test E2E del flujo auth multi-tenant.
 *
 * Valida (sin levantar el API HTTP):
 *   1. Crear tenant nuevo vía TenantsAdminService logic
 *   2. Crear role + user en ese tenant nuevo
 *   3. Login del user en tenant correcto → JWT con tenant_id correcto
 *   4. Login con tenant_slug equivocado falla
 *   5. Login con password equivocado falla
 *   6. Username repetido en distintos tenants funciona (cada uno independiente)
 *   7. Tenant inactivo no permite login
 *
 * Corre directo contra la DB local con clients pg (sin HTTP).
 *
 * Run: node database/test-newdb-auth-multitenant.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const ADMIN_URL = process.env.DATABASE_URL_NEW; // postgres (bypass RLS)
const APP_URL =
  process.env.DATABASE_URL_NEW_RUNTIME ||
  process.env.DATABASE_URL_NEW.replace('postgres:superoot', 'app_runtime:app_runtime');

const TENANT_A_ID = '00000000-0000-0000-0000-00000000d01c'; // Mega Dulces (existente)
const TENANT_B_ID = '00000000-0000-0000-0000-00000000aaaa'; // Test secundario

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else      { console.error(`  ✗ ${msg}`); fail++; }
}

async function withCtx(client, tid, fn) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL app.tenant_id = '${tid}'`);
  try {
    const r = await fn();
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

/**
 * Simula la lógica de AuthMtService.login() — busca tenant_slug → tenant_id,
 * abre tx con context, busca user, verifica bcrypt, retorna payload simulado.
 */
async function simulateLogin(adminClient, appClient, dto) {
  const tenant = await adminClient.query(
    `SELECT id, slug, nombre, activo FROM tenants WHERE slug = $1 AND activo = true`,
    [dto.tenant_slug],
  );
  if (tenant.rowCount === 0) throw new Error('Credenciales inválidas (tenant)');
  const t = tenant.rows[0];

  const user = await withCtx(appClient, t.id, async () => {
    const r = await appClient.query(
      `SELECT id, username, password_hash, role_name FROM users WHERE username = $1 AND activo = true`,
      [dto.username],
    );
    return r.rows[0];
  });
  if (!user) throw new Error('Credenciales inválidas (user)');

  const ok = await bcrypt.compare(dto.password, user.password_hash);
  if (!ok) throw new Error('Credenciales inválidas (password)');

  return { sub: user.id, tenant_id: t.id, username: user.username, role_name: user.role_name };
}

(async () => {
  const adminClient = new Client({ connectionString: ADMIN_URL });
  const appClient = new Client({ connectionString: APP_URL });
  await adminClient.connect();
  await appClient.connect();

  try {
    console.log('═══ Setup: crear tenant B + role + user ═══\n');

    // Crear tenant B
    await adminClient.query(`
      INSERT INTO tenants (id, slug, nombre, plan, activo)
      VALUES ('${TENANT_B_ID}', 'tenant_b_test', 'Tenant B Test', 'standard', true)
      ON CONFLICT (slug) DO NOTHING
    `);

    // Crear rol en tenant B
    await withCtx(appClient, TENANT_B_ID, async () => {
      await appClient.query(`
        INSERT INTO role_permissions (tenant_id, role_name, permissions)
        VALUES (current_tenant_id(), 'admin', '{"USUARIOS_VER":true}')
        ON CONFLICT (tenant_id, role_name) DO NOTHING
      `);
    });

    // Crear user 'superoot' (mismo username que tenant A) en tenant B con password distinto
    const hashB = await bcrypt.hash('superoot_b', 10);
    await withCtx(appClient, TENANT_B_ID, async () => {
      await appClient.query(
        `INSERT INTO users (tenant_id, username, password_hash, nombre, role_name)
         VALUES (current_tenant_id(), 'superoot', $1, 'Super Root B', 'admin')
         ON CONFLICT (tenant_id, username) DO NOTHING`,
        [hashB],
      );
    });

    console.log('  ✓ Setup completo (tenant B + role admin + user superoot/superoot_b)');

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 1: login válido en tenant A ═══\n');
    const r1 = await simulateLogin(adminClient, appClient, {
      tenant_slug: 'mega_dulces',
      username: 'superoot',
      password: 'superoot',
    });
    assert(r1.tenant_id === TENANT_A_ID, `JWT carga tenant_id de Mega Dulces (got ${r1.tenant_id})`);
    assert(r1.role_name === 'superadmin', `role_name correcto (got ${r1.role_name})`);

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 2: login válido en tenant B con MISMO username ═══\n');
    const r2 = await simulateLogin(adminClient, appClient, {
      tenant_slug: 'tenant_b_test',
      username: 'superoot',
      password: 'superoot_b',
    });
    assert(r2.tenant_id === TENANT_B_ID, `JWT carga tenant_id de Tenant B (got ${r2.tenant_id})`);
    assert(r2.role_name === 'admin', `role_name de tenant B (got ${r2.role_name})`);
    assert(r1.sub !== r2.sub, 'sub (user id) son distintos entre tenants');

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 3: cross-tenant password fallido ═══\n');
    try {
      // Username superoot existe en A, intento con password de B
      await simulateLogin(adminClient, appClient, {
        tenant_slug: 'mega_dulces',
        username: 'superoot',
        password: 'superoot_b', // password de tenant B
      });
      assert(false, 'Login con password de otro tenant NO debe pasar');
    } catch (e) {
      assert(e.message.includes('password'), `Rechazado por password incorrecto`);
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 4: tenant_slug inexistente ═══\n');
    try {
      await simulateLogin(adminClient, appClient, {
        tenant_slug: 'no_existe',
        username: 'superoot',
        password: 'superoot',
      });
      assert(false, 'Login con tenant inexistente debe fallar');
    } catch (e) {
      assert(e.message.includes('tenant'), 'Rechazado por tenant inexistente');
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 5: user de tenant A NO puede loguear en tenant B ═══\n');
    // En tenant A hay superoot. En tenant B también hay superoot, pero password distinto.
    // Si pruebo username de A + password de A pero tenant slug B → falla por password mismatch.
    try {
      await simulateLogin(adminClient, appClient, {
        tenant_slug: 'tenant_b_test',
        username: 'superoot',
        password: 'superoot', // password de tenant A
      });
      assert(false, 'No debe pasar');
    } catch (e) {
      assert(e.message.includes('password'), 'Rechazado por password incorrecto (tenant B requiere superoot_b)');
    }

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 6: tenant inactivo no permite login ═══\n');
    await adminClient.query(`UPDATE tenants SET activo = false WHERE id = '${TENANT_B_ID}'`);
    try {
      await simulateLogin(adminClient, appClient, {
        tenant_slug: 'tenant_b_test',
        username: 'superoot',
        password: 'superoot_b',
      });
      assert(false, 'Login en tenant inactivo debe fallar');
    } catch (e) {
      assert(e.message.includes('tenant'), 'Rechazado porque tenant inactivo');
    }
    // Reactivar para cleanup limpio
    await adminClient.query(`UPDATE tenants SET activo = true WHERE id = '${TENANT_B_ID}'`);

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Test 7: tenants concurrentes con clientes separados ═══\n');
    // Para concurrencia real necesitamos 2 conexiones distintas (en runtime
    // NestJS, el pool de Knex asigna una conexión por tx). Aquí simulamos
    // creando 2 clientes pg separados.
    const concClientA = new Client({ connectionString: APP_URL });
    const concClientB = new Client({ connectionString: APP_URL });
    await concClientA.connect();
    await concClientB.connect();

    const [idA, idB] = await Promise.all([
      withCtx(concClientA, TENANT_A_ID, async () => {
        await new Promise((r) => setTimeout(r, 30));
        const r = await concClientA.query(`SELECT id, username FROM users WHERE username = 'superoot'`);
        return r.rows[0].id;
      }),
      withCtx(concClientB, TENANT_B_ID, async () => {
        await new Promise((r) => setTimeout(r, 30));
        const r = await concClientB.query(`SELECT id, username FROM users WHERE username = 'superoot'`);
        return r.rows[0].id;
      }),
    ]);
    await concClientA.end();
    await concClientB.end();

    assert(idA !== idB, `Users 'superoot' tienen UUIDs distintos entre tenants (A: ${idA.slice(0,8)}…, B: ${idB.slice(0,8)}…)`);
    assert(idA === '00000000-0000-0000-0000-00000000d0aa', 'Tenant A devuelve el superoot seedeado');
    assert(idB !== '00000000-0000-0000-0000-00000000d0aa', 'Tenant B devuelve un superoot distinto (gen_random_uuid)');

    // ─────────────────────────────────────────────────────────────────────
    console.log('\n═══ Cleanup ═══\n');
    await adminClient.query(`DELETE FROM users WHERE tenant_id = '${TENANT_B_ID}'`);
    await adminClient.query(`DELETE FROM role_permissions WHERE tenant_id = '${TENANT_B_ID}'`);
    await adminClient.query(`DELETE FROM tenants WHERE id = '${TENANT_B_ID}'`);
    console.log('  ✓ Tenant B + data eliminada');

    console.log(`\n═══════════ Resultado: ${pass} pass / ${fail} fail ═══════════`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error('\n✗ Excepción inesperada:', err.message);
    console.error(err.stack);
    // Cleanup defensivo
    await adminClient.query(`DELETE FROM users WHERE tenant_id = '${TENANT_B_ID}'`).catch(() => {});
    await adminClient.query(`DELETE FROM role_permissions WHERE tenant_id = '${TENANT_B_ID}'`).catch(() => {});
    await adminClient.query(`DELETE FROM tenants WHERE id = '${TENANT_B_ID}'`).catch(() => {});
    process.exit(2);
  } finally {
    await appClient.end();
    await adminClient.end();
  }
})();
