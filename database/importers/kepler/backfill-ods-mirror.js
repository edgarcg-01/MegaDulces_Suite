/* eslint-disable no-console */
/**
 * BACKFILL del ODS hacia una réplica de pruebas — **local → local, cero egress**.
 *
 * Llena `kepler_ods.*` de la réplica (`.245/platform_test`) leyendo los **réplicas lógicos
 * locales** del contenedor (`:5433/kepler_md_XX`, la 03 es `kepler_pilot`). NO toca prod:
 * bajar los ~5 GB por el proxy de Railway es egress pago y ~50× más lento (medido: 4 s por
 * LAN para las 49 k filas de `kdm1` de una rama, contra ~30 min de proxy para una fracción).
 *
 * Por qué un script aparte y no `replicate-ods-live.js --full`: el watermark (`ods.ctl`) y el
 * shadow de hashes (`ods.shadow`) viven en el ORIGEN y son **estado compartido con el CDC de
 * prod**. Una pasada full los avanzaría y prod se saltearía filas que nunca shipeó. Esto solo
 * LEE `md.*` y escribe la réplica — no escribe ni una fila de estado.
 *
 * El espejo del sink debe estar quieto mientras corre (los loops del ODS detenidos), o el
 * TRUNCATE entra en deadlock contra un `raw-upsert` en vuelo.
 *
 * Env: MIRROR_URL (destino) · KEPLER_REPLICA_BASE (origen, default :5433)
 * Uso: node database/importers/kepler/backfill-ods-mirror.js --apply [--tables=kdm1,kdm2]
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { Client } = require('pg');
const { spawn } = require('node:child_process');
const path = require('node:path');

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--tables=')) || '').split('=')[1];
const DST_URL = process.env.MIRROR_URL || process.env.FEEDS_MIRROR_URL;
const SRC_BASE = process.env.KEPLER_REPLICA_BASE || 'postgresql://postgres:superoot@localhost:5433/postgres';
const PSQL = process.env.PSQL_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';

// La 03 quedó con el nombre del piloto (rename diferido); md_03 es un sobrante de junio.
const BRANCHES = [
  ['00', 'kepler_md_00'], ['01', 'kepler_md_01'], ['02', 'kepler_md_02'],
  ['03', 'kepler_pilot'], ['04', 'kepler_md_04'], ['05', 'kepler_md_05'], ['06', 'kepler_md_06'],
];
// Meta del CDC: se replica sola, no tiene sentido copiarla.
const SKIP = new Set(['_sync_status']);

if (!DST_URL) { console.error('Falta MIRROR_URL (o FEEDS_MIRROR_URL) apuntando a la réplica.'); process.exit(2); }
if (/proxy\.rlwy\.net|railway/i.test(DST_URL)) { console.error('ABORT: el destino es prod. Este script trunca tablas.'); process.exit(2); }

/** Conexión por partes → la contraseña va por PGPASSWORD, nunca en la línea de comando
 *  (un `Get-CimInstance Win32_Process` la mostraría a cualquiera con la máquina abierta). */
function parts(url, dbOverride) {
  const u = new URL(url);
  return {
    host: u.hostname, port: u.port || '5432',
    db: dbOverride || decodeURIComponent(u.pathname.replace(/^\//, '')),
    user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password),
  };
}
const urlFor = (p) => `postgresql://${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass)}@${p.host}:${p.port}/${p.db}`;

async function cols(url, schema, table) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [schema, table]);
    return r.rows.map((x) => x.column_name);
  } finally { await c.end(); }
}

/** psql origen (COPY … TO STDOUT) | psql destino (COPY … FROM STDIN), por LAN. */
function pipeCopy(src, dst, selectSql, insertSql) {
  return new Promise((resolve) => {
    const args = (p, sql) => ['-h', p.host, '-p', p.port, '-U', p.user, '-d', p.db, '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql];
    const out = spawn(PSQL, args(src, selectSql), { env: { ...process.env, PGPASSWORD: src.pass } });
    const inn = spawn(PSQL, args(dst, insertSql), { env: { ...process.env, PGPASSWORD: dst.pass } });
    let err = '';
    out.stdout.pipe(inn.stdin);
    out.stderr.on('data', (d) => (err += d));
    inn.stderr.on('data', (d) => (err += d));
    let done = 0;
    const fin = () => { if (++done === 2) resolve(err.trim()); };
    out.on('close', fin);
    inn.on('close', fin);
  });
}

(async () => {
  const dstP = parts(DST_URL);
  const db = new Client({ connectionString: DST_URL });
  await db.connect();

  // Tablas destino (las que el clon de prod ya trae) y sus columnas.
  const tgt = (await db.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='kepler_ods' AND c.relkind='r' ORDER BY 1`)).rows.map((r) => r.relname)
    .filter((t) => !SKIP.has(t))
    .filter((t) => !ONLY || ONLY.split(',').includes(t));
  const tgtCols = new Map();
  for (const t of tgt) tgtCols.set(t, await cols(DST_URL, 'kepler_ods', t));

  // Qué md.* trae cada rama (una consulta por rama, no por tabla).
  const plan = [];
  for (const [code, dbName] of BRANCHES) {
    const srcUrl = urlFor(parts(SRC_BASE, dbName));
    let srcTables;
    try {
      const c = new Client({ connectionString: srcUrl });
      await c.connect();
      const r = await c.query(
        `SELECT table_name, string_agg(column_name, ',' ORDER BY ordinal_position) cols
         FROM information_schema.columns WHERE table_schema='md' GROUP BY 1`);
      await c.end();
      srcTables = new Map(r.rows.map((x) => [x.table_name, x.cols.split(',')]));
    } catch (e) {
      console.error(`  rama ${code} (${dbName}): no conecta → skip · ${e.message.slice(0, 80)}`);
      continue;
    }
    for (const t of tgt) {
      const sc = srcTables.get(t);
      if (!sc) continue;
      // Intersección de columnas: el ODS pudo ganar columnas que el origen ya no tiene (o al revés).
      const inter = tgtCols.get(t).filter((c) => c !== 'sucursal' && sc.includes(c));
      if (inter.length) plan.push({ table: t, code, dbName, cols: inter });
    }
  }

  const tablesToLoad = [...new Set(plan.map((p) => p.table))];
  console.log(`\n=== Backfill ODS local→local (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`  destino: ${dstP.host}/${dstP.db}`);
  console.log(`  ${tablesToLoad.length} tablas con origen · ${plan.length} pares (tabla×rama)`);
  console.log(`  ${tgt.length - tablesToLoad.length} tablas del destino SIN origen en md.* → quedan vacías`);
  if (!APPLY) { await db.end(); console.log('\n(dry-run: nada escrito)'); return; }

  // TRUNCATE una vez por tabla; las ramas escriben sucursal distinta → no se pisan.
  await db.query(`TRUNCATE ${tablesToLoad.map((t) => `kepler_ods.${JSON.stringify(t)}`).join(', ')}`);
  console.log(`  ${tablesToLoad.length} tablas truncadas\n`);

  let ok = 0; let fail = 0; const fails = [];
  const t0 = Date.now();
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const list = p.cols.map((c) => `"${c}"`).join(',');
    const srcP = parts(SRC_BASE, p.dbName);
    const err = await pipeCopy(
      srcP, dstP,
      `COPY (SELECT '${p.code}' AS sucursal, ${list} FROM md.${JSON.stringify(p.table)}) TO STDOUT`,
      `COPY kepler_ods.${JSON.stringify(p.table)} (sucursal,${list}) FROM STDIN`,
    );
    if (err && /ERROR|FATAL/i.test(err)) { fail++; fails.push(`${p.code}/${p.table}: ${err.split('\n')[0].slice(0, 110)}`); }
    else ok++;
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${plan.length} (ok=${ok} fail=${fail})`);
  }

  const rows = (await db.query(
    `SELECT coalesce(sum(n_live_tup),0)::bigint n FROM pg_stat_user_tables WHERE schemaname='kepler_ods'`)).rows[0].n;
  console.log(`\n=== ${ok} ok / ${fail} fallidas en ${Math.round((Date.now() - t0) / 1000)}s ===`);
  if (fails.length) { console.log('fallidas:'); fails.slice(0, 25).forEach((f) => console.log('  ✗ ' + f)); }
  console.log(`kepler_ods en la réplica: ~${Number(rows).toLocaleString('es-MX')} filas`);
  await db.end();
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
