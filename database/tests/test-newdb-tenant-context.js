#!/usr/bin/env node
/**
 * Script de validación end-to-end del tenant context en la nueva DB.
 *
 * Valida que:
 *   1. `SET LOCAL app.tenant_id` funciona dentro de una transacción.
 *   2. `current_tenant_id()` lee correctamente el valor seteado.
 *   3. Otra transacción sin SET ve `current_tenant_id()` como NULL.
 *   4. El seteo NO leaks fuera de la transacción (queries siguientes en el
 *      mismo pool ven NULL).
 *
 * Correr desde la raíz del repo:
 *   node database/test-newdb-tenant-context.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const knex = require('knex')({
  client: 'pg',
  connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: false },
  pool: { min: 1, max: 3 },
});

const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';

async function setTenantContext(trx, tenantId) {
  await trx.raw(`SET LOCAL app.tenant_id = '${tenantId}'`);
}

async function runWithTenant(tenantId, callback) {
  return knex.transaction(async (trx) => {
    await setTenantContext(trx, tenantId);
    return callback(trx);
  });
}

let pass = 0, fail = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    pass++;
  } else {
    console.error(`  ✗ ${message}`);
    fail++;
  }
}

(async () => {
  console.log('═══ Validación tenant context — postgres_platform ═══\n');

  try {
    // Test 1: setear tenant context y leerlo
    console.log('Test 1: setear y leer tenant context dentro de transacción');
    const result1 = await runWithTenant(MEGA_DULCES_TENANT_ID, async (trx) => {
      const r = await trx.raw('SELECT current_tenant_id() AS tid');
      return r.rows[0].tid;
    });
    assert(
      result1 === MEGA_DULCES_TENANT_ID,
      `current_tenant_id() devuelve el UUID seteado (got: ${result1})`,
    );

    // Test 2: sin contexto, debe ser NULL
    console.log('\nTest 2: sin SET, current_tenant_id() debe ser NULL');
    const result2 = await knex.raw('SELECT current_tenant_id() AS tid');
    assert(
      result2.rows[0].tid === null,
      `current_tenant_id() es NULL sin SET (got: ${result2.rows[0].tid})`,
    );

    // Test 3: el SET LOCAL no leaks fuera de la transacción
    console.log('\nTest 3: SET LOCAL no leaks fuera de la transacción');
    await runWithTenant(MEGA_DULCES_TENANT_ID, async (trx) => {
      // dentro: SÍ ve el tenant
    });
    const result3 = await knex.raw('SELECT current_tenant_id() AS tid');
    assert(
      result3.rows[0].tid === null,
      `Post-tx, current_tenant_id() vuelve a NULL (got: ${result3.rows[0].tid})`,
    );

    // Test 4: el tenant_id es accesible para queries dentro de la tx
    console.log('\nTest 4: query SELECT * FROM tenants WHERE id = current_tenant_id() funciona');
    const result4 = await runWithTenant(MEGA_DULCES_TENANT_ID, async (trx) => {
      const r = await trx('tenants').where({ id: trx.raw('current_tenant_id()') }).first();
      return r;
    });
    assert(
      result4 && result4.slug === 'mega_dulces',
      `Encuentra el tenant correcto via current_tenant_id() (got: ${result4 ? result4.slug : 'null'})`,
    );

    // Test 5: tenantId inválido (no UUID) debe rechazarse al setear
    // Nota: el helper TS lanza BadRequestException; aquí lo simulamos con regex.
    console.log('\nTest 5: tenantId inválido se detecta (regex check)');
    const TENANT_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert(
      !TENANT_UUID_REGEX.test("'; DROP TABLE tenants; --"),
      'Regex rechaza SQL injection attempt en tenantId',
    );
    assert(
      TENANT_UUID_REGEX.test(MEGA_DULCES_TENANT_ID),
      'Regex acepta UUID válido',
    );

    // Test 6: dos transacciones concurrentes con tenants distintos NO se mezclan
    console.log('\nTest 6: aislamiento entre transacciones concurrentes');
    const OTHER_TENANT_ID = '00000000-0000-0000-0000-00000000d02d';
    // Insertamos un tenant adicional temporal solo para este test.
    await knex('tenants').insert({
      id: OTHER_TENANT_ID,
      slug: 'temp_test_tenant',
      nombre: 'Test Tenant',
    }).onConflict('slug').ignore();

    const [resA, resB] = await Promise.all([
      runWithTenant(MEGA_DULCES_TENANT_ID, async (trx) => {
        await new Promise((r) => setTimeout(r, 50)); // overlap concurrencia
        const r = await trx.raw('SELECT current_tenant_id() AS tid');
        return r.rows[0].tid;
      }),
      runWithTenant(OTHER_TENANT_ID, async (trx) => {
        await new Promise((r) => setTimeout(r, 50));
        const r = await trx.raw('SELECT current_tenant_id() AS tid');
        return r.rows[0].tid;
      }),
    ]);
    assert(
      resA === MEGA_DULCES_TENANT_ID,
      `Tx A mantiene su tenant (got: ${resA})`,
    );
    assert(
      resB === OTHER_TENANT_ID,
      `Tx B mantiene su tenant (got: ${resB})`,
    );

    // Cleanup: borrar el tenant temporal
    await knex('tenants').where({ slug: 'temp_test_tenant' }).delete();

    console.log(`\n═══ Resultado: ${pass} pass / ${fail} fail ═══`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error('\n✗ Excepción inesperada:', err.message);
    process.exit(2);
  } finally {
    await knex.destroy();
  }
})();
