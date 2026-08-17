/* eslint-disable no-console */
/**
 * SYNC.3 — vía VIVA CDC: replicas lógicos locales → prod kepler_ods (al-segundo, sin tocar el POS).
 *
 * Evoluciona replicate-ods-fast.js. Aquel POLLEA las sucursales md.* REMOTAS por ctid (carga el POS
 * y PIERDE los UPDATE in-place de catálogos — un HOT-update reusa un slot ≤ watermark → `ctid>wm` lo
 * salta; fue el bug del precio 89137). ESTE lee los **replicas lógicos LOCALES** (kepler_md_XX en el
 * contenedor pgvector-md :5433, alimentados por replicación lógica nativa = siempre al día, capturan
 * UPDATE) → cero lecturas al POS, y arregla la pérdida de UPDATE con dos carriles:
 *
 *   • Carril CTID (tablas grandes append-only: kdm1, kdm2, kdij, kdue, kdpord):
 *     como en origen no hay UPDATE/DELETE, el ctid es monótono → Tid Range Scan barato, sin pérdida.
 *   • Carril HASH (catálogos chicos mutables: kdii, kdil, kdik, kdig, kdud, kdid, kduv, kdm_*):
 *     full-scan LOCAL + md5(fila) contra un shadow local (ods.shadow) → shipea SOLO las filas cuyo
 *     hash cambió. Captura todo UPDATE; el egress = solo el delta real.
 *
 * Control/estado co-locado en cada replica (schema `ods`): NO depende de .245, NO colisiona con el
 * watermark del normalizer remoto (kp.ods_fast_control). Ship idéntico al viejo (handler 'raw-upsert',
 * UPSERT sin churn) → el destino prod kepler_ods no cambia.
 *
 * Limitaciones (heredadas, aceptadas): hard-DELETE en origen no se propaga (UPSERT no borra).
 *
 * Env: DATABASE_URL_NEW (base del contenedor de replicas) · KP_ODS_TABLES · ODS_HASH_TABLES
 *      ODS_LIVE_BRANCHES (default 01,02,03,04,05,06 — CEDIS 00 no está en replicación lógica)
 *      FEEDS_SINK=http + FEEDS_INGEST_URL + FEEDS_INGEST_KEY · CRON_TENANT_ID
 *      ODS_READ_BATCH (5000) · ODS_SHIP_BATCH (5000)
 * Flags: --apply (default dry-run) · --tables=kdii,kdil · --branch=03 · --full (ignora watermark ctid)
 *        --watch[=segundos] (loop continuo; default 10s; implica apply)
 *
 *   node database/importers/kepler/replicate-ods-live.js --tables=kdii             # dry-run (cuenta delta)
 *   node database/importers/kepler/replicate-ods-live.js --apply                    # una pasada
 *   node database/importers/kepler/replicate-ods-live.js --apply --watch=10         # loop cada 10s
 */

const { Client } = require('pg');
const sink = require('../lib/sink');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const FULL = process.argv.includes('--full');
const PRIME = process.argv.includes('--prime');
const ONLY_BRANCH = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null;
const ONLY = (process.argv.find((a) => a.startsWith('--tables=')) || '').split('=')[1];
const WATCH_ARG = process.argv.find((a) => a === '--watch' || a.startsWith('--watch='));
const WATCH_SEC = WATCH_ARG ? Math.max(3, Number(WATCH_ARG.split('=')[1] || 10)) : 0;

const TABLES = (ONLY || process.env.KP_ODS_TABLES || 'kdm1,kdm2,kdii,kdil,kdig,kdik,kdib,kdid,kdij,kdue,kduv,kdud,kdm_rutas,kdm_transporte,kdm_chofer,kdpord')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Catálogos mutables (UPDATE in-place) → carril hash. El resto → carril ctid (append-only o grande).
const HASH_TABLES = new Set(
  (process.env.ODS_HASH_TABLES || 'kdii,kdil,kdik,kdig,kdid,kduv,kdud,kdm_rutas,kdm_transporte,kdm_chofer')
    .split(',').map((s) => s.trim()).filter(Boolean));
const READ_BATCH = Math.max(500, Number(process.env.ODS_READ_BATCH) || 5000);
const SHIP_BATCH = Math.max(500, Number(process.env.ODS_SHIP_BATCH) || 5000);

const CONN = { connectionTimeoutMillis: 15000, statement_timeout: 300000, query_timeout: 300000, keepAlive: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Destino. En FEEDS_SINK=http (prod) el ship va por HTTP y no se usa cliente. En FEEDS_SINK=pg
// (on-prem / test) se aplica directo con este cliente contra KP_DEST_URL (default = replicas base).
const DEST_URL = process.env.KP_DEST_URL || null;
let DEST = null; // Client de pg cuando el sink es 'pg'; null en http.
const ship = (rows, meta) => sink.ship('raw-upsert', { rows, tenantId: TENANT, meta, client: DEST });

// Base de conexión al contenedor de replicas (localhost:5433). El replica de md_03 quedó con el
// nombre del piloto (kepler_pilot); el resto es kepler_md_XX. Rename diferido (cosmético).
const SUB_BASE = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const localUrl = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return u.toString(); };
const BRANCH_CODES = (process.env.ODS_LIVE_BRANCHES || '01,02,03,04,05,06').split(',').map((s) => s.trim()).filter(Boolean);
const BRANCHES = BRANCH_CODES.map((code) => ({ code, url: localUrl(code) }));

function mapType(dt) {
  switch (dt) {
    case 'numeric': return 'numeric';
    case 'double precision': return 'double precision';
    case 'real': return 'real';
    case 'integer': return 'integer';
    case 'bigint': return 'bigint';
    case 'smallint': return 'smallint';
    case 'boolean': return 'boolean';
    case 'date': return 'date';
    case 'timestamp without time zone': return 'timestamp';
    case 'timestamp with time zone': return 'timestamptz';
    default: return 'text';
  }
}
const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';

/** Estado co-locado en el replica: watermark ctid + shadow de hashes. */
async function ensureLocalCtl(p) {
  await p.query('CREATE SCHEMA IF NOT EXISTS ods');
  await p.query(`CREATE TABLE IF NOT EXISTS ods.ctl (
      table_name  text PRIMARY KEY,
      last_ctid   text NOT NULL DEFAULT '(0,0)',
      rows_last   integer DEFAULT 0,
      changed_last integer DEFAULT 0,
      last_run_at timestamptz NOT NULL DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS ods.shadow (
      table_name text NOT NULL,
      pk_text    text NOT NULL,
      h          text NOT NULL,
      PRIMARY KEY (table_name, pk_text))`);
}

/** Columnas + PK de md.<table> en este replica. */
async function tableMeta(src, table) {
  const cols = (await src.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='md' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
  if (!cols.length) return null;
  const pk = (await src.query(`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
    WHERE i.indrelid=('md.'||$1)::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`, [table])).rows.map((r) => r.attname);
  return { cols, pk };
}

/** Expresión SQL que arma el pk_text (NULL-safe) desde el alias `t`. */
const pkExpr = (pk) => pk.map((c) => `COALESCE(t.${qid(c)}::text,'\\x00')`).join(` || '|' || `);

function shipMetaOf(table, meta) {
  return { table, pk: meta.pk, columns: [{ name: 'sucursal', type: 'text' }, ...meta.cols.map((c) => ({ name: c.column_name, type: mapType(c.data_type) }))] };
}

/** Carril CTID: append-only grandes. Lee ctid>watermark, empuja, avanza watermark. */
async function syncCtid(p, code, table, meta, { apply, full }) {
  const selList = meta.cols.map((c) => qid(c.column_name)).join(', ');
  const shipMeta = shipMetaOf(table, meta);
  const wmRow = (await p.query(`SELECT last_ctid FROM ods.ctl WHERE table_name=$1`, [table])).rows[0];
  const wm = full ? '(0,0)' : (wmRow && wmRow.last_ctid) || '(0,0)';

  if (!apply) {
    const n = Number((await p.query(`SELECT count(*)::bigint n FROM md.${qid(table)} WHERE ctid > $1::tid`, [wm])).rows[0].n);
    return { suc: code, tabla: table, carril: 'ctid', desde: wm, candidatas: n };
  }

  let lastCtid = wm, seen = 0, changed = 0, buf = [];
  const flush = async () => {
    if (!buf.length) return;
    const r = await ship(buf, shipMeta);
    changed += Number(r.rowCount || 0); buf = [];
  };
  for (;;) {
    const rows = (await p.query(
      `SELECT ctid, ${selList} FROM md.${qid(table)} WHERE ctid > $1::tid ORDER BY ctid LIMIT ${READ_BATCH}`, [lastCtid])).rows;
    if (!rows.length) break;
    lastCtid = rows[rows.length - 1].ctid;
    for (const row of rows) {
      const o = { sucursal: code };
      for (const c of meta.cols) o[c.column_name] = row[c.column_name];
      buf.push(o); seen++;
      if (buf.length >= SHIP_BATCH) await flush();
    }
  }
  await flush();
  await p.query(
    `INSERT INTO ods.ctl (table_name, last_ctid, rows_last, changed_last, last_run_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (table_name) DO UPDATE SET last_ctid=EXCLUDED.last_ctid,
       rows_last=EXCLUDED.rows_last, changed_last=EXCLUDED.changed_last, last_run_at=now()`,
    [table, lastCtid, seen, changed]);
  if (seen) console.log(`  ✓ ${code}/${table} [ctid]: ${seen} leídas · ${changed} escritas · ctid→${lastCtid}`);
  return { suc: code, tabla: table, carril: 'ctid', leidas: seen, escritas: changed };
}

/** Carril HASH: catálogos chicos mutables. Delta = filas cuyo md5(fila) difiere del shadow local. */
async function syncHash(p, code, table, meta, { apply, full }) {
  const selList = meta.cols.map((c) => qid(c.column_name)).join(', ');
  const shipMeta = shipMetaOf(table, meta);
  const pkx = pkExpr(meta.pk);
  // full = ignora shadow (re-shipea todo y reconstruye shadow); útil primera pasada / resync.
  const joinCond = full
    ? `FALSE`
    : `s.table_name='${table.replace(/'/g, "''")}' AND s.pk_text = ${pkx}`;
  const deltaSql = `
    SELECT ${pkx} AS __pk, md5(t::text) AS __h, ${selList}
    FROM md.${qid(table)} t
    LEFT JOIN ods.shadow s ON ${joinCond}
    WHERE s.pk_text IS NULL OR s.h IS DISTINCT FROM md5(t::text)`;

  if (!apply) {
    const n = Number((await p.query(`SELECT count(*)::bigint n FROM (${deltaSql}) d`)).rows[0].n);
    return { suc: code, tabla: table, carril: 'hash', candidatas: n };
  }

  const rows = (await p.query(deltaSql)).rows;
  if (!rows.length) return { suc: code, tabla: table, carril: 'hash', leidas: 0, escritas: 0 };

  let changed = 0, buf = [], shadowVals = [];
  const flush = async () => {
    if (!buf.length) return;
    const r = await ship(buf, shipMeta);
    changed += Number(r.rowCount || 0); buf = [];
  };
  for (const row of rows) {
    shadowVals.push([table, row.__pk, row.__h]);
    const o = { sucursal: code };
    for (const c of meta.cols) o[c.column_name] = row[c.column_name];
    buf.push(o);
    if (buf.length >= SHIP_BATCH) await flush();
  }
  await flush();

  // Actualiza shadow SOLO de las filas shipeadas (tras push OK).
  for (let i = 0; i < shadowVals.length; i += 1000) {
    const chunk = shadowVals.slice(i, i + 1000);
    const params = [];
    const tuples = chunk.map((v, j) => { const b = j * 3; params.push(v[0], v[1], v[2]); return `($${b + 1},$${b + 2},$${b + 3})`; }).join(',');
    await p.query(
      `INSERT INTO ods.shadow (table_name, pk_text, h) VALUES ${tuples}
       ON CONFLICT (table_name, pk_text) DO UPDATE SET h=EXCLUDED.h`, params);
  }
  console.log(`  ✓ ${code}/${table} [hash]: ${rows.length} delta · ${changed} escritas`);
  return { suc: code, tabla: table, carril: 'hash', leidas: rows.length, escritas: changed };
}

/** PRIME: fija el watermark ctid de las tablas del carril ctid al MÁXIMO actual, sin shipear.
 *  Para el cutover de sucursales cuyos movimientos prod ya tiene (01-05) → solo se shipea lo NUEVO.
 *  NO toca el carril hash (esos se re-shipean 1 vez para corregir catálogos stale en prod). */
async function primeCtid() {
  for (const b of BRANCHES) {
    if (ONLY_BRANCH && b.code !== ONLY_BRANCH) continue;
    const p = new Client({ connectionString: b.url, ssl: false, ...CONN });
    try { await p.connect(); } catch (e) { console.log(`  ⚠ replica ${b.code}: no conecta — skip`); continue; }
    try {
      await ensureLocalCtl(p);
      for (const table of TABLES) {
        if (HASH_TABLES.has(table)) continue;
        const meta = await tableMeta(p, table);
        if (!meta || !meta.pk.length) continue;
        const r = await p.query(`SELECT ctid FROM md.${qid(table)} ORDER BY ctid DESC LIMIT 1`);
        const wm = r.rows.length ? r.rows[0].ctid : '(0,0)';
        await p.query(
          `INSERT INTO ods.ctl (table_name, last_ctid, last_run_at) VALUES ($1,$2, now())
           ON CONFLICT (table_name) DO UPDATE SET last_ctid=EXCLUDED.last_ctid, last_run_at=now()`, [table, wm]);
        console.log(`  ⚑ ${b.code}/${table}: watermark → ${wm}`);
      }
    } finally { await p.end().catch(() => {}); }
  }
}

/** Un ciclo: cada replica local × tablas, ruteando por carril. */
async function cycleAll({ apply, full }) {
  const summary = [];
  for (const b of BRANCHES) {
    if (ONLY_BRANCH && b.code !== ONLY_BRANCH) continue;
    const p = new Client({ connectionString: b.url, ssl: false, ...CONN });
    try { await p.connect(); }
    catch (e) { console.log(`  ⚠ replica ${b.code} (${localDbName(b.code)}): no conecta (${e.message.slice(0, 50)}) — skip`); continue; }
    try {
      await ensureLocalCtl(p);
      for (const table of TABLES) {
        try {
          const meta = await tableMeta(p, table);
          if (!meta) { summary.push({ suc: b.code, tabla: table, skip: 'no existe' }); continue; }
          if (!meta.pk.length) { summary.push({ suc: b.code, tabla: table, skip: 'sin PK' }); continue; }
          const fn = HASH_TABLES.has(table) ? syncHash : syncCtid;
          summary.push(await fn(p, b.code, table, meta, { apply, full }));
        } catch (e) { console.log(`  ✗ ${b.code}/${table}: ${e.message.slice(0, 90)}`); summary.push({ suc: b.code, tabla: table, error: e.message.slice(0, 45) }); }
      }
    } finally { await p.end().catch(() => {}); }
  }
  return summary;
}

(async () => {
  console.log(`\n=== replicate-ods-LIVE — replicas locales → kepler_ods (${APPLY || WATCH_SEC ? 'APPLY' : 'DRY-RUN'}${FULL ? ', FULL' : ''}${WATCH_SEC ? `, WATCH ${WATCH_SEC}s` : ''}) ===`);
  console.log(`  sink: ${sink.sinkMode()}  ·  ramas: ${BRANCH_CODES.join(',')}  ·  tablas: ${TABLES.length}`);
  console.log(`  carril hash: ${[...HASH_TABLES].join(',')}`);

  if (PRIME) {
    console.log(`  PRIME — fijando watermark ctid al máximo actual (sin shipear)…`);
    await primeCtid();
    console.log('PRIME hecho. Ahora corré --apply --watch para shipear solo lo nuevo (ctid) + catálogos.');
    return;
  }

  // Modo pg (on-prem/test): abre el cliente destino (default = base de replicas).
  if (sink.sinkMode() === 'pg') {
    DEST = new Client({ connectionString: DEST_URL || SUB_BASE, ssl: false, ...CONN });
    await DEST.connect();
    console.log(`  destino pg: ${new URL(DEST_URL || SUB_BASE).host}${new URL(DEST_URL || SUB_BASE).pathname}`);
  }

  if (!WATCH_SEC) {
    const summary = await cycleAll({ apply: APPLY, full: FULL });
    console.log('\n=== Resumen ===');
    console.table(summary.slice(0, 200));
    console.log(APPLY ? 'APPLY hecho.' : 'DRY-RUN — nada cambió. Corré con --apply.');
    if (DEST) await DEST.end().catch(() => {});
    return;
  }

  console.log(`  watch activo — Ctrl+C para salir.`);
  let cycle = 0;
  for (;;) {
    cycle++;
    const t0 = Date.now();
    try {
      const summary = await cycleAll({ apply: true, full: FULL && cycle === 1 });
      const wrote = summary.reduce((a, r) => a + (r.escritas || 0), 0);
      if (wrote) console.log(`  ── ciclo ${cycle}: ${wrote} filas escritas (${Date.now() - t0}ms) ──`);
    } catch (e) {
      console.error(`  ✗ ciclo ${cycle}: ${e.message.slice(0, 120)}`);
    }
    await sleep(WATCH_SEC * 1000);
  }
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
