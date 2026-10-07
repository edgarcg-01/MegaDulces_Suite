#!/usr/bin/env node
/**
 * Resetea el password del rol `app_runtime` en un Postgres **on-prem** (sin SSL).
 *
 * Hermano de `setup-runtime-role.js`, que es para Railway y **fuerza
 * `ssl: { rejectUnauthorized: false }`** — contra el cluster de oficina
 * (`192.168.0.245`) eso falla en el primer `SELECT 1`, así que ese script no
 * sirve acá. Única diferencia real: el SSL se decide por el host.
 *
 * ¿Por qué hace falta? `app_runtime` es el rol con el que la app corre en
 * runtime: **no es superuser y no bypasea RLS**, y por eso es el único con el
 * que el aislamiento por tenant se prueba de verdad. Si su password no coincide
 * con `DATABASE_URL_NEW_RUNTIME`, Postgres tira `28P01` y **toda la superficie
 * multi-tenant responde 500** — el rol existe y puede loguear, pero nadie
 * adivina la contraseña.
 *
 * El password de un rol es **del cluster, no de una base**: tocarlo afecta a
 * `platform_test` y a `postgres_platform` a la vez, y a cualquier otra máquina
 * que se conecte con ese rol. Por eso el script:
 *   - avisa qué bases del cluster quedan afectadas ANTES de escribir;
 *   - exige `--yes` para ejecutar (sin él sólo diagnostica);
 *   - imprime la línea lista para pegar en el `.env`.
 *
 * Uso:
 *   node database/scripts/setup-runtime-role-local.js               # diagnóstico
 *   node database/scripts/setup-runtime-role-local.js --yes         # resetea
 *   APP_RUNTIME_PASSWORD=... node ... --yes                         # con uno propio
 *
 * Toma el host/puerto/base de `DATABASE_URL_NEW` (rol superusuario) del `.env`.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const knex = require('knex');
const crypto = require('crypto');

const APLICAR = process.argv.includes('--yes');

/** SSL sólo para hosts remotos; el cluster de oficina no lo tiene configurado. */
const esLocal = (host) => /^(localhost|127\.0\.0\.1|192\.168\.|10\.)/.test(host);

async function main() {
  const admUrl = process.env.DATABASE_URL_NEW;
  if (!admUrl) {
    console.error('Falta DATABASE_URL_NEW en el .env (se necesita el rol superusuario).');
    process.exit(1);
  }
  const url = new URL(admUrl);
  const host = url.hostname;
  const port = Number(url.port || 5432);
  const base = url.pathname.replace(/^\//, '');

  const db = knex({
    client: 'pg',
    connection: {
      connectionString: admUrl,
      ssl: esLocal(host) ? false : { rejectUnauthorized: false },
    },
    pool: { min: 0, max: 2 },
  });

  try {
    console.log(`\n[1/5] Conectando como ${url.username} a ${host}:${port}/${base}…`);
    await db.raw('SELECT 1');
    console.log('      OK');

    console.log('\n[2/5] Estado del rol app_runtime…');
    const rol = await db.raw(
      `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolvaliduntil
         FROM pg_roles WHERE rolname = 'app_runtime'`,
    );
    if (!rol.rows.length) {
      console.error('      ERROR: el rol no existe — falta la migración 20260526000003.');
      process.exit(1);
    }
    const r = rol.rows[0];
    if (r.rolsuper || r.rolbypassrls) {
      console.error(
        `      ERROR: rolsuper=${r.rolsuper} bypassrls=${r.rolbypassrls}. ` +
          'Con cualquiera de los dos en true, RLS no filtra y el rol deja de servir para lo que existe.',
      );
      process.exit(1);
    }
    console.log(`      OK — NOSUPERUSER NOBYPASSRLS, login=${r.rolcanlogin}, vence=${r.rolvaliduntil ?? 'nunca'}`);

    console.log('\n[3/5] Bases del cluster que quedan afectadas (el password es del CLUSTER)…');
    const bases = await db.raw(
      `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`,
    );
    console.log(`      ${bases.rows.map((x) => x.datname).join(', ')}`);
    console.log('      Cualquier otra máquina que se conecte con app_runtime a este cluster');
    console.log('      va a dejar de andar hasta que actualice su .env.');

    if (!APLICAR) {
      console.log('\n[4/5] Modo DIAGNÓSTICO: no se escribió nada.');
      console.log('      Para resetear el password:  node database/scripts/setup-runtime-role-local.js --yes\n');
      return;
    }

    const password = process.env.APP_RUNTIME_PASSWORD || crypto.randomBytes(24).toString('base64url');
    console.log('\n[4/5] ALTER ROLE app_runtime WITH PASSWORD …');
    // DDL: no acepta bind params. El generado es base64url (sin comillas), pero
    // igual se escapa por si viene de APP_RUNTIME_PASSWORD.
    await db.raw(`ALTER ROLE app_runtime WITH PASSWORD '${password.replace(/'/g, "''")}'`);
    console.log('      OK');

    console.log('\n[5/5] Verificando login real con el rol…');
    const prueba = knex({
      client: 'pg',
      connection: {
        host, port, database: base, user: 'app_runtime', password,
        ssl: esLocal(host) ? false : { rejectUnauthorized: false },
      },
      pool: { min: 0, max: 1 },
      acquireConnectionTimeout: 8000,
    });
    try {
      const q = await prueba.raw('SELECT current_user u, current_database() d');
      console.log(`      OK — conecta como ${q.rows[0].u} a ${q.rows[0].d}`);
    } finally {
      await prueba.destroy();
    }

    console.log('\n─────────────── pegá esto en el .env de CADA worktree ───────────────');
    console.log(`DATABASE_URL_NEW_RUNTIME=postgresql://app_runtime:${password}@${host}:${port}/${base}`);
    console.log('─────────────────────────────────────────────────────────────────────');
    console.log('(y `APP_RUNTIME_PASSWORD` si algún script lo usa por separado)\n');
  } finally {
    await db.destroy();
  }
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
