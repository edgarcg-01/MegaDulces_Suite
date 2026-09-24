'use strict';
/**
 * CANDADO — cada schema con tablas debe darle USAGE a `app_runtime` (el rol que el runtime hereda).
 *
 * Nace de un 42501 real en prod (2026-09-17): la migración que creó el schema `budget` otorgó
 * permisos de TABLA pero olvidó `GRANT USAGE ON SCHEMA budget TO app_runtime`. Sin USAGE del
 * schema los grants de tabla son inútiles — Postgres deniega el schema primero — y
 * `/api/finance/payment-calendar/*` tiraba 500. El patrón canónico
 * (20260526100001_commercial_customers_warehouses) siempre hace CREATE SCHEMA + GRANT USAGE +
 * ALTER DEFAULT PRIVILEGES juntos; este script verifica que NINGÚN schema se lo haya saltado.
 *
 * "Un gate sin prueba negativa es una intención": si mañana una migración crea un schema y no le
 * da USAGE, este check sale con 1 y lo caza antes de que la pantalla tire 500 en prod.
 *
 *   node database/scripts/check-schema-grants.js          # contra DATABASE_URL_NEW (local/test)
 *   node database/scripts/check-schema-grants.js --prod   # contra FLEET_DB_URL (prod)
 *
 * Sólo lectura. NUNCA imprime la cadena de conexión.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

// Schemas de sistema/infra que NO son de la app (no se exige USAGE de app_runtime).
const IGNORAR = new Set(['pg_catalog', 'information_schema', 'pg_toast']);

(async () => {
  const prod = process.argv.includes('--prod');
  // ⛔ [CT.7 2026-09-24] `--prod` leía `FLEET_DB_URL`, y en el `.env` de una máquina de desarrollo
  // esa variable apunta a **Railway** — la prod vieja, de la que nos mudamos el 22-sep. O sea que
  // auditaba los permisos del clúster equivocado y contestaba en verde. Mismo defecto que había en
  // `check-applied-migrations.js` y que `[VL.18]` ya había corregido en `apply-one-migration-prod`.
  //
  // ⚠️ La trampa fina: en `md` (`~/secrets/feeds.env`) `FLEET_DB_URL` SÍ apunta a `pg-prod`. Un
  // mismo nombre con dos valores según dónde corras — por eso no alcanza con mirar el nombre de la
  // variable: hay que verificar la IDENTIDAD del clúster antes de creerle una fila.
  const url = prod
    ? (process.env.DATABASE_URL_NEW_PROD || process.env.PROD_DB_URL || process.env.FLEET_DB_URL)
    : process.env.DATABASE_URL_NEW;
  if (!url) { console.error(`Falta ${prod ? 'PROD_DB_URL' : 'DATABASE_URL_NEW'} en .env`); process.exit(1); }
  const local = /localhost|127\.0\.0\.1|192\.168\.|pg-prod/.test(url);
  const c = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  await c.connect();
  if (prod) {
    const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';
    const { rows: [id] } = await c.query(
      'select (select system_identifier from pg_control_system())::text as id, current_database() as db',
    );
    if (id.id !== PROD_CLUSTER_ID) {
      console.error('\n⛔ DESTINO EQUIVOCADO — no se audita nada, y NO se reporta verde.');
      console.error(`   clúster conectado : ${id.id} (base "${id.db}")`);
      console.error(`   clúster de prod   : ${PROD_CLUSTER_ID}`);
      console.error('   Definí PROD_DB_URL en tu .env (192.168.0.222:5434/railway).');
      await c.end();
      process.exit(1);
    }
    console.log(`  identidad de prod verificada: ${id.id} · base "${id.db}"`);
  }
  try {
    const { rows } = await c.query(`
      SELECT n.nspname AS schema,
             has_schema_privilege('app_runtime', n.nspname, 'USAGE') AS usage,
             count(t.tablename)::int AS tablas
        FROM pg_namespace n
        LEFT JOIN pg_tables t ON t.schemaname = n.nspname
       WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname NOT IN ('information_schema')
       GROUP BY n.nspname
      HAVING count(t.tablename) > 0
       ORDER BY n.nspname`);
    const conTablas = rows.filter((r) => !IGNORAR.has(r.schema));
    const faltan = conTablas.filter((r) => !r.usage);
    console.log(`Schemas con tablas: ${conTablas.length} · con USAGE app_runtime: ${conTablas.length - faltan.length}`);
    if (faltan.length) {
      console.error(`\n⛔ ${faltan.length} schema(s) SIN USAGE para app_runtime:`);
      for (const r of faltan) console.error(`   ✗ ${r.schema} (${r.tablas} tablas) — falta GRANT USAGE ON SCHEMA ${r.schema} TO app_runtime`);
      console.error('\nToda migración que hace CREATE SCHEMA debe seguirlo de GRANT USAGE + ALTER DEFAULT PRIVILEGES.');
      process.exit(1);
    }
    console.log('✓ Todos los schemas de la app le dan USAGE a app_runtime.');
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
