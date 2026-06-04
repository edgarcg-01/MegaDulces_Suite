#!/usr/bin/env node
/**
 * Setup del rol `app_runtime` en la new DB para production runtime.
 *
 * Qué hace:
 *  1. Conecta con el URL postgres provisto (rol superuser).
 *  2. Verifica que las migraciones estén aplicadas (knex_migrations + rol app_runtime).
 *  3. Genera un password fuerte (o usa el provisto en APP_RUNTIME_PASSWORD).
 *  4. ALTER ROLE app_runtime WITH PASSWORD '...'
 *  5. Verifica conexión con el rol app_runtime.
 *  6. Imprime las 2 env vars listas para pegar en Railway.
 *
 * Uso:
 *   node database/setup-runtime-role.js <DATABASE_URL_NEW> [INTERNAL_HOST]
 *
 *   <DATABASE_URL_NEW>  — public URL del addon (.proxy.rlwy.net) para que este
 *                         script pueda conectar desde tu máquina local.
 *   [INTERNAL_HOST]     — opcional. Host interno de Railway (postgres-xxx.railway.internal)
 *                         que va en DATABASE_URL_NEW_RUNTIME. Si no se pasa, usa
 *                         el host del URL provisto.
 *
 * Ejemplo:
 *   node database/setup-runtime-role.js \
 *     "postgresql://postgres:whh...@trolley.proxy.rlwy.net:39023/railway" \
 *     "postgres-oqkq.railway.internal:5432"
 */
const knex = require('knex');
const crypto = require('crypto');

async function main() {
  const publicUrl = process.argv[2];
  const internalHost = process.argv[3]; // optional override

  if (!publicUrl) {
    console.error('ERROR: falta el primer argumento DATABASE_URL_NEW (URL público .proxy.rlwy.net)');
    console.error('Uso: node database/setup-runtime-role.js <PUBLIC_URL> [INTERNAL_HOST:PORT]');
    process.exit(1);
  }

  const url = new URL(publicUrl);
  const dbName = url.pathname.replace(/^\//, '');

  const password = process.env.APP_RUNTIME_PASSWORD || crypto.randomBytes(24).toString('base64url');

  const db = knex({
    client: 'pg',
    connection: {
      connectionString: publicUrl,
      ssl: { rejectUnauthorized: false },
    },
    pool: { min: 0, max: 2 },
  });

  try {
    console.log(`\n[1/5] Conectando a ${url.hostname}:${url.port}/${dbName}...`);
    await db.raw('SELECT 1');
    console.log('      OK');

    console.log('\n[2/5] Verificando migraciones aplicadas...');
    const migrations = await db('knex_migrations').select('name').orderBy('id', 'desc').limit(5);
    if (migrations.length === 0) {
      console.error('      ERROR: knex_migrations vacío — correr cutover-to-railway.js primero');
      process.exit(1);
    }
    console.log(`      OK — ${migrations.length} migraciones (última: ${migrations[0].name})`);

    console.log('\n[3/5] Verificando rol app_runtime...');
    const role = await db.raw(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'"
    );
    if (role.rows.length === 0) {
      console.error('      ERROR: rol app_runtime no existe — migración 003 no se aplicó');
      process.exit(1);
    }
    const r = role.rows[0];
    if (r.rolsuper || r.rolbypassrls) {
      console.error(`      ERROR: app_runtime tiene rolsuper=${r.rolsuper} bypassrls=${r.rolbypassrls} — no debe ser superuser ni bypass RLS`);
      process.exit(1);
    }
    console.log('      OK — app_runtime NOSUPERUSER NOBYPASSRLS');

    console.log('\n[4/5] Reseteando password de app_runtime...');
    // ALTER ROLE is DDL — no acepta bind params. Password es base64url (safe chars),
    // pero igual escapamos comilla simple por defensive coding.
    const escapedPwd = password.replace(/'/g, "''");
    await db.raw(`ALTER ROLE app_runtime WITH PASSWORD '${escapedPwd}'`);
    console.log('      OK');

    console.log('\n[5/5] Verificando conexión con app_runtime...');
    const testDb = knex({
      client: 'pg',
      connection: {
        host: url.hostname,
        port: parseInt(url.port, 10),
        database: dbName,
        user: 'app_runtime',
        password: password,
        ssl: { rejectUnauthorized: false },
      },
      pool: { min: 0, max: 2 },
    });
    try {
      await testDb.raw('SELECT 1');
      const tenantCheck = await testDb.raw("SELECT count(*)::int as n FROM tenants WHERE deleted_at IS NULL");
      console.log(`      OK — login app_runtime funcional. ${tenantCheck.rows[0].n} tenants activos visibles (sin context, RLS bloquea per-row).`);
    } finally {
      await testDb.destroy();
    }

    const runtimeHost = internalHost || `${url.hostname}:${url.port}`;
    const runtimeUrl = `postgresql://app_runtime:${encodeURIComponent(password)}@${runtimeHost}/${dbName}`;

    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('  ENV VARS PARA RAILWAY (servicio API → Variables)');
    console.log('══════════════════════════════════════════════════════════════════\n');
    console.log(`APP_RUNTIME_PASSWORD=${password}`);
    console.log(`DATABASE_URL_NEW_RUNTIME=${runtimeUrl}`);
    console.log('\n──────────────────────────────────────────────────────────────────');
    console.log('  Pasos siguientes:');
    console.log('  1. Copiá las 2 env vars de arriba.');
    console.log('  2. Pegalas en Railway → servicio API → Variables.');
    console.log('  3. Quitá SKIP_MIGRATIONS=1 (las migraciones ya están idempotentes).');
    console.log('  4. Redeploy.');
    console.log('  5. Verificar log: debe decir "<from DATABASE_URL_NEW_RUNTIME>", no "(fallback)".');
    console.log('══════════════════════════════════════════════════════════════════\n');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error('\n[setup-runtime-role] FAIL:', err.message);
  process.exit(1);
});
