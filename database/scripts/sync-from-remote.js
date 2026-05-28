#!/usr/bin/env node
/**
 * Sincroniza el Docker local `pgvector-md` (localhost:5433) con la DB
 * remota `postgres_platform` en 192.168.0.245 (la "source of truth").
 *
 * Pasos:
 *   1. Stop + remove container `pgvector-md` + drop volumen.
 *   2. Levantar container nuevo limpio (pgvector/pgvector:pg18).
 *   3. pg_dump del remoto (--no-owner --no-acl) usando pg_dump.exe nativo
 *      Windows 18 (matchea la versión del server).
 *   4. Restore al Docker via streaming stdin (evita docker cp + MSYS path issues).
 *   5. Recreate rol `app_runtime` con grants en los 4 schemas.
 *   6. Aplicar migraciones-newdb (incluye K.0/K-shim/K-sync) — algunas
 *      pueden no existir en el remoto, pero son idempotentes.
 *   7. Ejecutar backfill de embeddings para products sin embedding.
 *
 * **Requisitos**:
 *   - Docker Desktop corriendo.
 *   - `pg_dump.exe` en `C:\\Program Files\\PostgreSQL\\18\\bin\\` (PG18 nativo Windows).
 *   - `.env` con DATABASE_URL_REMOTE_SNAPSHOT y VOYAGE_API_KEY.
 *
 * **Cuándo usar**:
 *   - Edgar modificó data en .245 y quiere ver los cambios en local.
 *   - El catálogo se actualizó en prod y hay que refrescar dev.
 *   - Hay drift entre los dos servers y queremos resetear.
 *
 * **NO usa** en flujo regular — los hooks + cron + trigger mantienen
 * integridad dentro del Docker. Este script es para resetear el espejo.
 *
 * Ejecución:
 *   node database/scripts/sync-from-remote.js
 *   node database/scripts/sync-from-remote.js --skip-backfill   (más rápido si solo quieres el dump)
 *   node database/scripts/sync-from-remote.js --remote URL      (override del remote)
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const knexLib = require('knex');

const PG_DUMP_EXE = 'C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe';
const CONTAINER = 'pgvector-md';
const VOLUME = 'pgvector-md-data';
const IMAGE = 'pgvector/pgvector:pg18';
const HOST_PORT = 5433;
const POSTGRES_PASSWORD = 'superoot';
const POSTGRES_DB = 'postgres_platform';
const LOCAL_URL = `postgresql://postgres:${POSTGRES_PASSWORD}@localhost:${HOST_PORT}/${POSTGRES_DB}`;

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { skipBackfill: false, remote: process.env.DATABASE_URL_REMOTE_SNAPSHOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--skip-backfill') opts.skipBackfill = true;
    else if (argv[i] === '--remote') opts.remote = argv[++i];
  }
  return opts;
}

function log(stage, msg) {
  console.log(`\n━━━ ${stage} ━━━\n${msg}`);
}

function run(cmd, args, options = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    stdio: options.stdio || 'inherit',
    shell: false,
    input: options.input,
    encoding: options.encoding || 'utf8',
  });
  if (r.status !== 0 && !options.allowFail) {
    throw new Error(`Comando falló (exit ${r.status}): ${cmd} ${args.join(' ')}`);
  }
  return r;
}

async function waitForReady() {
  process.stdout.write('  Esperando Postgres ready');
  for (let i = 0; i < 60; i++) {
    const r = spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', POSTGRES_DB], { stdio: 'ignore' });
    if (r.status === 0) {
      console.log(' ✓');
      return;
    }
    await new Promise((res) => setTimeout(res, 1000));
    process.stdout.write('.');
  }
  throw new Error('Postgres no responde después de 60s');
}

async function main() {
  const opts = parseArgs();
  if (!opts.remote) {
    console.error('Falta DATABASE_URL_REMOTE_SNAPSHOT en .env o flag --remote URL.');
    process.exit(1);
  }
  if (!fs.existsSync(PG_DUMP_EXE)) {
    console.error(`pg_dump.exe no encontrado en ${PG_DUMP_EXE}. Ajustar la constante.`);
    process.exit(1);
  }

  // ── 1. Stop + remove container + volume ────────────────────────────────
  log('1/7', 'Limpiando container y volumen actuales');
  run('docker', ['stop', CONTAINER], { stdio: 'ignore', allowFail: true });
  run('docker', ['rm', CONTAINER], { stdio: 'ignore', allowFail: true });
  run('docker', ['volume', 'rm', VOLUME], { stdio: 'ignore', allowFail: true });

  // ── 2. Levantar container limpio ───────────────────────────────────────
  log('2/7', `Levantando container ${CONTAINER} (${IMAGE})`);
  run('docker', [
    'run', '-d',
    '--name', CONTAINER,
    '-p', `${HOST_PORT}:5432`,
    '-e', `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '-e', `POSTGRES_DB=${POSTGRES_DB}`,
    '-v', `${VOLUME}:/var/lib/postgresql`,
    IMAGE,
  ]);
  await waitForReady();

  // ── 3. pg_dump del remoto ──────────────────────────────────────────────
  log('3/7', `pg_dump del remoto a /tmp/sync-dump.bin`);
  const url = new URL(opts.remote);
  const dumpPath = path.join(require('os').tmpdir(), `sync-dump-${Date.now()}.bin`);
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
  run(PG_DUMP_EXE, [
    '-h', url.hostname,
    '-p', url.port || '5432',
    '-U', decodeURIComponent(url.username),
    '-d', url.pathname.slice(1),
    '--no-owner', '--no-acl',
    '-Fc',
    '-f', dumpPath,
  ], { stdio: 'inherit' });
  const dumpSize = (fs.statSync(dumpPath).size / 1024).toFixed(0);
  console.log(`  Dump generado: ${dumpSize} KB`);

  // ── 4. Restore al container via streaming stdin ────────────────────────
  log('4/7', 'Streaming dump al container y restore');
  // Copiamos al container via stream (evita docker cp + MSYS path conversion).
  const dumpStream = fs.readFileSync(dumpPath);
  run('docker', ['exec', '-i', CONTAINER, 'sh', '-c', 'cat > //tmp/sync-dump.bin'], {
    input: dumpStream,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'buffer',
  });
  run('docker', [
    'exec',
    '-e', `PGPASSWORD=${POSTGRES_PASSWORD}`,
    CONTAINER,
    'sh', '-c',
    `pg_restore -U postgres -d ${POSTGRES_DB} --no-owner --no-acl /tmp/sync-dump.bin || true`,
  ]);
  fs.unlinkSync(dumpPath);

  // ── 5. Recreate app_runtime role + grants ──────────────────────────────
  log('5/7', 'Recreate rol app_runtime con grants en 4 schemas');
  const grantSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_runtime') THEN
        CREATE ROLE app_runtime LOGIN PASSWORD 'app_runtime';
      END IF;
    END$$;
    GRANT USAGE ON SCHEMA public, commercial, analytics, logistics TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA commercial TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA analytics TO app_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA logistics TO app_runtime;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA commercial TO app_runtime;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA analytics TO app_runtime;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA logistics TO app_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA commercial GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA logistics GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
  `;
  run('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', POSTGRES_DB, '-v', 'ON_ERROR_STOP=1'], {
    input: grantSql,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  // ── 6. Aplicar migraciones-newdb (idempotentes) ────────────────────────
  log('6/7', 'knex migrate:latest sobre migrations-newdb (incluye trigger K-sync, columna activo, etc.)');
  const knex = knexLib({
    client: 'pg',
    connection: LOCAL_URL,
    migrations: { directory: path.resolve(__dirname, '../migrations-newdb') },
  });
  try {
    const [batch, applied] = await knex.migrate.latest();
    if (applied.length > 0) {
      console.log(`  Batch ${batch}: aplicadas ${applied.length} migraciones nuevas`);
      applied.forEach((m) => console.log('    + ' + m));
    } else {
      console.log('  Todo al día. No hay migraciones pendientes.');
    }
  } finally {
    await knex.destroy();
  }

  // ── 7. Backfill embeddings ─────────────────────────────────────────────
  if (opts.skipBackfill) {
    console.log('\n— Skip backfill por flag.');
  } else {
    log('7/7', 'Backfill de embeddings (solo products sin embedding)');
    process.env.DATABASE_URL = LOCAL_URL;
    const backfillPath = path.resolve(__dirname, 'backfill-product-embeddings.js');
    run(process.execPath, [backfillPath]);
  }

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Sincronía Docker ← .245 completada                      ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\nDocker disponible en ${LOCAL_URL}`);
  console.log('La instancia remota .245 NO fue modificada.');
}

main().catch((e) => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
