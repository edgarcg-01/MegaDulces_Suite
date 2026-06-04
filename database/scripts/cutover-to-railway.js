#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Orquestador de cutover a Railway — DB nueva multi-tenant en paralelo.
 *
 * Estrategia: Opción A (recomendada). Crea la nueva DB desde cero en Railway,
 * mantiene la DB legacy intacta como respaldo histórico hasta que se confirme
 * que la app funciona contra la nueva. Después del cutover, las env vars
 * de la API en Railway apuntan a `DATABASE_URL_NEW` y la legacy queda
 * congelada (no se borra hasta que pase un período prudente).
 *
 * Pasos automáticos:
 *   1. Verifica que `DATABASE_URL_NEW` apunta a una DB vacía (sin tablas).
 *      Si tiene tablas → ABORTA (pide --force-not-empty para overwrite peligroso).
 *   2. Corre las 30 migraciones knex (`migrations-newdb/`)
 *   3. Corre los 6 seeds (`seeds-newdb/`): tenant Mega Dulces + roles + superoot
 *      + commercial baseline + customer demo + logistics baseline (importer
 *      embebido).
 *   4. Reporta tablas creadas, schemas, tenant_id, último migration aplicado.
 *
 * Después de este script, el usuario debe:
 *   - Correr `migrate-legacy-to-newdb.js` para llevar la data histórica.
 *   - Configurar env vars de la API en Railway:
 *       DATABASE_URL_NEW=<la URL de la DB nueva>
 *       ENABLE_MULTITENANT=true
 *       JWT_SECRET=<secret real, NO el default>
 *   - Restart del servicio API en Railway.
 *
 * Uso:
 *   DATABASE_URL_NEW="postgresql://..." node database/cutover-to-railway.js
 *   DATABASE_URL_NEW="postgresql://..." node database/cutover-to-railway.js --skip-seeds
 *   DATABASE_URL_NEW="postgresql://..." node database/cutover-to-railway.js --force-not-empty
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex');
const { spawnSync } = require('child_process');
const path = require('path');

const TARGET_URL = process.env.DATABASE_URL_NEW;
const SKIP_SEEDS = process.argv.includes('--skip-seeds');
const SKIP_BASELINE = process.argv.includes('--skip-baseline');
const FORCE = process.argv.includes('--force-not-empty');

if (!TARGET_URL) {
  console.error('❌ ERROR: Falta env var DATABASE_URL_NEW');
  console.error('');
  console.error('Uso:');
  console.error('  DATABASE_URL_NEW="postgresql://user:pass@host:port/dbname" \\');
  console.error('    node database/cutover-to-railway.js');
  process.exit(1);
}

const SSL_REQUIRED = TARGET_URL.includes('railway') || TARGET_URL.includes('rds.amazonaws') || TARGET_URL.includes('supabase');

(async () => {
  const db = knex({
    client: 'pg',
    connection: { connectionString: TARGET_URL, ssl: SSL_REQUIRED ? { rejectUnauthorized: false } : undefined },
    pool: { min: 1, max: 5 },
  });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  CUTOVER TO RAILWAY — DB nueva multi-tenant');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Target URL: ${TARGET_URL.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`SSL: ${SSL_REQUIRED ? 'enabled' : 'disabled'}`);
  console.log('');

  // ── Step 1: Verificar conexión ────────────────────────────────────────
  console.log('[1/4] Conectando a target...');
  try {
    const r = await db.raw('SELECT current_database() AS db, current_user AS usr, version()');
    console.log(`  ✓ Conectado a "${r.rows[0].db}" como "${r.rows[0].usr}"`);
    console.log(`  ✓ ${r.rows[0].version.split(',')[0]}`);
  } catch (e) {
    console.error('  ✗ Conexión falló:', e.message);
    process.exit(1);
  }

  // ── Step 2: Verificar DB vacía ────────────────────────────────────────
  console.log('\n[2/4] Verificando que la DB está vacía...');
  const tables = await db.raw(`
    SELECT table_schema || '.' || table_name AS qualified
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
      AND table_type = 'BASE TABLE'
    ORDER BY qualified
  `);
  const tableCount = tables.rows.length;
  if (tableCount > 0) {
    console.log(`  ⚠️ DB tiene ${tableCount} tablas existentes:`);
    for (const t of tables.rows.slice(0, 10)) console.log(`    · ${t.qualified}`);
    if (tableCount > 10) console.log(`    · ... +${tableCount - 10} más`);

    if (!FORCE) {
      console.error('\n❌ ABORTANDO: DB target no está vacía.');
      console.error('   Para sobreescribir (peligroso, asume que sabés lo que hacés):');
      console.error('   DATABASE_URL_NEW=... node database/cutover-to-railway.js --force-not-empty');
      process.exit(1);
    }
    console.log('  ⚠️ --force-not-empty: continúo igual (knex skip las migraciones ya aplicadas).');
  } else {
    console.log('  ✓ DB vacía. OK para correr migraciones desde cero.');
  }

  // ── Step 3: Aplicar las 30 migraciones ────────────────────────────────
  console.log('\n[3/4] Aplicando migraciones (migrations-newdb/)...');
  await db.destroy();

  const env = {
    ...process.env,
    DATABASE_URL_NEW: TARGET_URL,
    NODE_ENV: 'production', // Para que el knexfile-newdb seleccione el bloque production
  };

  const knexResult = spawnSync(
    'npx',
    [
      'knex',
      'migrate:latest',
      '--knexfile',
      path.resolve(__dirname, '..', 'knexfile-newdb.js'),
      '--env',
      'production',
    ],
    { stdio: 'inherit', shell: true, env, cwd: path.resolve(__dirname, '..', '..') }
  );
  if (knexResult.status !== 0) {
    console.error('\n❌ knex migrate:latest falló. Revisá output arriba.');
    process.exit(1);
  }
  console.log('  ✓ Migraciones aplicadas correctamente.');

  // ── Step 4: Seeds ─────────────────────────────────────────────────────
  if (SKIP_SEEDS) {
    console.log('\n[4/4] --skip-seeds: omitiendo seeds.');
  } else {
    console.log('\n[4/4] Aplicando seeds (seeds-newdb/)...');
    const seedResult = spawnSync(
      'npx',
      [
        'knex',
        'seed:run',
        '--knexfile',
        path.resolve(__dirname, '..', 'knexfile-newdb.js'),
        '--env',
        'production',
      ],
      { stdio: 'inherit', shell: true, env, cwd: path.resolve(__dirname, '..', '..') }
    );
    if (seedResult.status !== 0) {
      console.error('\n❌ knex seed:run falló. Revisá output arriba.');
      process.exit(1);
    }
    console.log('  ✓ Seeds aplicados.');
  }

  // ── Step 5 (opcional): Importer logistics_baseline ────────────────────
  if (!SKIP_BASELINE && !SKIP_SEEDS) {
    console.log('\n[5/5] Importer logistics_baseline (96 destinos + 26 períodos + 23 config)...');
    const importerResult = spawnSync(
      'node',
      ['database/importers/logistics_baseline.js', '--tenant-slug=mega_dulces'],
      { stdio: 'inherit', shell: true, env, cwd: path.resolve(__dirname, '..', '..') }
    );
    if (importerResult.status !== 0) {
      console.error('\n⚠️ Importer logistics_baseline falló. Podés correrlo manualmente después.');
    } else {
      console.log('  ✓ Importer baseline aplicado.');
    }
  }

  // ── Resumen final ─────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const finalDb = knex({
    client: 'pg',
    connection: { connectionString: TARGET_URL, ssl: SSL_REQUIRED ? { rejectUnauthorized: false } : undefined },
    pool: { min: 1, max: 2 },
  });
  try {
    const counts = await finalDb.raw(`
      SELECT
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'commercial' AND table_type = 'BASE TABLE') AS commercial,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'logistics' AND table_type = 'BASE TABLE') AS logistics,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'analytics' AND table_type = 'BASE TABLE') AS analytics,
        (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS public_tables,
        (SELECT COUNT(*) FROM knex_migrations) AS migrations,
        (SELECT COUNT(*) FROM public.tenants WHERE activo = true) AS active_tenants
    `);
    const c = counts.rows[0];
    console.log('  RESUMEN POST-CUTOVER');
    console.log(`    commercial tables: ${c.commercial}`);
    console.log(`    logistics tables:  ${c.logistics}`);
    console.log(`    analytics tables:  ${c.analytics}`);
    console.log(`    public tables:     ${c.public_tables}`);
    console.log(`    migrations applied: ${c.migrations}`);
    console.log(`    active tenants:    ${c.active_tenants}`);

    if (!SKIP_SEEDS) {
      const tenants = await finalDb('public.tenants').select('id', 'slug', 'name');
      console.log('\n  Tenants creados:');
      for (const t of tenants) console.log(`    · ${t.slug} (${t.id}) — ${t.name}`);
    }
  } finally {
    await finalDb.destroy();
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✓ CUTOVER COMPLETO');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Próximos pasos:');
  console.log('  1. Migrar data legacy a la nueva DB:');
  console.log('     LEGACY_DATABASE_URL="postgresql://...railway-legacy..." \\');
  console.log('       DATABASE_URL_NEW="' + TARGET_URL.replace(/:[^:@]+@/, ':****@') + '" \\');
  console.log('       node database/migrate-legacy-to-newdb.js --dry-run');
  console.log('     (sin --dry-run para aplicar real)');
  console.log('');
  console.log('  2. Configurar env vars en Railway (servicio API):');
  console.log('     DATABASE_URL_NEW=' + TARGET_URL.replace(/:[^:@]+@/, ':****@'));
  console.log('     ENABLE_MULTITENANT=true');
  console.log('     JWT_SECRET=<generar uno fuerte, NO el default>');
  console.log('');
  console.log('  3. Restart del servicio API en Railway.');
  console.log('');
  console.log('  4. Smoke test contra la nueva DB:');
  console.log('     curl https://<api-railway>/api/auth-mt/login \\');
  console.log('       -H "Content-Type: application/json" \\');
  console.log('       -d \'{"tenant_slug":"mega_dulces","username":"superoot","password":"superoot"}\'');
  console.log('');
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
