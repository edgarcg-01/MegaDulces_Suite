/* eslint-disable no-console */
/**
 * SYNC.2.5 — vía RÁPIDA CDC Kepler → prod kepler_ods (watermark por ctid, al-minuto / al-segundo).
 *
 * A diferencia de replicate-ods.js (lee KP_CONCENTRADA, tan fresco como el concentrate de 4h),
 * ESTE lee las sucursales md.* DIRECTO y empuja al mismo handler 'raw-upsert' (UPSERT sin churn).
 * Un solo salto branches→prod, sin depender del concentrate → verdaderamente al-minuto.
 *
 * Incremental BARATO por **ctid**: guarda el último ctid leído por (sucursal, tabla) y lee
 * `WHERE ctid > last ORDER BY ctid` → en Postgres 16 es un **Tid Range Scan** (solo bloques
 * nuevos, NO seq-scan de millones). Verificado: md.* = PG 16.4. Captura INSERTs y UPDATEs
 * (un UPDATE crea una tupla nueva con ctid mayor → se re-lee → UPSERT prod la deja al día).
 *
 * Modo --watch: en vez de correr una vez, cicla cada N segundos (default 10) con la conexión de
 * control persistente y reconectando las sucursales por ciclo. Como el ctid solo lee bloques
 * nuevos, un ciclo sin cambios cuesta ~0 → se puede tener kepler_ods.* casi-vivo sin tocar el POS.
 *
 * Limitaciones (por diseño, aceptadas): (1) hard-DELETE en origen no se propaga (UPSERT no borra;
 * raro en ERP). (2) VACUUM FULL reescribe ctids → correr `--full` (nightly) resincroniza
 * (lee todo por ctid, UPSERT churn-free, resetea watermark). autovacuum normal NO mueve tuplas vivas.
 *
 * Watermark en `kp.ods_fast_control` (en KP_CONCENTRADA .245, on-prem — NO toca prod → cero egress).
 *
 * Env: KP_BRANCH_MAP (sucursales) · KP_ODS_TABLES (curadas) · CTRL_URL (default KP_CONCENTRADA)
 *      FEEDS_SINK=http + FEEDS_INGEST_URL + FEEDS_INGEST_KEY · CRON_TENANT_ID
 *      ODS_READ_BATCH (5000) · ODS_SHIP_BATCH (5000)
 * Flags: --apply (default dry-run) · --tables=kdii,kdil · --branch=00 · --full (ignora watermark)
 *        --watch[=segundos] (loop continuo; default 10s; implica correr en modo apply)
 *
 *   node database/importers/kepler/replicate-ods-fast.js --tables=kdil            # dry-run
 *   node database/importers/kepler/replicate-ods-fast.js --tables=kdil --apply    # una vez
 *   node database/importers/kepler/replicate-ods-fast.js --apply --watch=10       # loop cada 10s
 */

const { Client } = require('pg');
const sink = require('../lib/sink');

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const CTRL_URL = process.env.CTRL_URL || process.env.KP_DEST_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
const APPLY = process.argv.includes('--apply');
const FULL = process.argv.includes('--full');
const ONLY_BRANCH = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null;
const ONLY = (process.argv.find((a) => a.startsWith('--tables=')) || '').split('=')[1];
const WATCH_ARG = process.argv.find((a) => a === '--watch' || a.startsWith('--watch='));
const WATCH_SEC = WATCH_ARG ? Math.max(3, Number(WATCH_ARG.split('=')[1] || 10)) : 0;
const TABLES = (ONLY || process.env.KP_ODS_TABLES || 'kdm1,kdm2,kdii,kdil,kdig,kdik,kdib,kdid,kdij,kdue,kduv')
  .split(',').map((s) => s.trim()).filter(Boolean);
const READ_BATCH = Math.max(500, Number(process.env.ODS_READ_BATCH) || 5000);
const SHIP_BATCH = Math.max(500, Number(process.env.ODS_SHIP_BATCH) || 5000);

const CONN = { connectionTimeoutMillis: 15000, statement_timeout: 300000, query_timeout: 300000, keepAlive: true };
// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { stockMap } = require('../lib/kepler-branches');
const BRANCHES = process.env.KP_BRANCH_MAP ? JSON.parse(process.env.KP_BRANCH_MAP) : stockMap({ cedis: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function ensureControl(ctrl) {
  await ctrl.query('CREATE SCHEMA IF NOT EXISTS kp');
  await ctrl.query(`
    CREATE TABLE IF NOT EXISTS kp.ods_fast_control (
      sucursal    text NOT NULL,
      table_name  text NOT NULL,
      last_ctid   text NOT NULL DEFAULT '(0,0)',
      rows_last   integer DEFAULT 0,
      changed_last integer DEFAULT 0,
      last_run_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (sucursal, table_name)
    )`);
}

/** Columnas + PK de md.<table> en ESTA sucursal. */
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

/** Sincroniza UNA tabla de UNA sucursal: lee ctid>watermark, empuja, avanza watermark.
 *  Devuelve un objeto de resumen (para dry-run cuenta candidatas; para apply reporta escritas). */
async function syncOneTable(ctrl, src, b, table, { apply, full }) {
  const meta0 = await tableMeta(src, table);
  if (!meta0) return { suc: b.code, tabla: table, skip: 'no existe aquí' };
  if (!meta0.pk.length) return { suc: b.code, tabla: table, skip: 'sin PK' };

  const metaCols = [{ name: 'sucursal', type: 'text' }, ...meta0.cols.map((c) => ({ name: c.column_name, type: mapType(c.data_type) }))];
  const selList = meta0.cols.map((c) => qid(c.column_name)).join(', ');
  const shipMeta = { table, pk: meta0.pk, columns: metaCols };

  const wmRow = (await ctrl.query(`SELECT last_ctid FROM kp.ods_fast_control WHERE sucursal=$1 AND table_name=$2`, [b.code, table])).rows[0];
  const wm = full ? '(0,0)' : (wmRow && wmRow.last_ctid) || '(0,0)';

  if (!apply) {
    const n = Number((await src.query(`SELECT count(*)::bigint n FROM md.${qid(table)} WHERE ctid > $1::tid`, [wm])).rows[0].n);
    return { suc: b.code, tabla: table, pk: meta0.pk.join(','), desde_ctid: wm, candidatas: n };
  }

  // Lectura keyset por ctid (Tid Range Scan) + ship por lotes.
  let lastCtid = wm, seen = 0, changed = 0, buf = [];
  const flush = async () => {
    if (!buf.length) return;
    const r = await sink.ship('raw-upsert', { rows: buf, tenantId: TENANT, meta: shipMeta });
    changed += Number(r.rowCount || 0); buf = [];
  };
  for (;;) {
    const rows = (await src.query(
      `SELECT ctid, ${selList} FROM md.${qid(table)} WHERE ctid > $1::tid ORDER BY ctid LIMIT ${READ_BATCH}`, [lastCtid])).rows;
    if (!rows.length) break;
    lastCtid = rows[rows.length - 1].ctid;
    for (const row of rows) {
      const o = { sucursal: b.code };
      for (const c of meta0.cols) o[c.column_name] = row[c.column_name];
      buf.push(o); seen++;
      if (buf.length >= SHIP_BATCH) await flush();
    }
  }
  await flush();

  // Avanza watermark SOLO tras push OK.
  await ctrl.query(
    `INSERT INTO kp.ods_fast_control (sucursal, table_name, last_ctid, rows_last, changed_last, last_run_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (sucursal, table_name) DO UPDATE SET last_ctid=EXCLUDED.last_ctid,
       rows_last=EXCLUDED.rows_last, changed_last=EXCLUDED.changed_last, last_run_at=now()`,
    [b.code, table, lastCtid, seen, changed]);
  if (seen) console.log(`  ✓ ${b.code}/${table}: ${seen} leídas · ${changed} escritas · ctid→${lastCtid}`);
  return { suc: b.code, tabla: table, leidas: seen, escritas: changed, ctid: lastCtid };
}

/** Un ciclo completo: todas las sucursales × tablas. Conecta/desconecta cada sucursal. */
async function cycleAll(ctrl, { apply, full }) {
  const summary = [];
  for (const b of BRANCHES) {
    if (ONLY_BRANCH && b.code !== ONLY_BRANCH) continue;
    const src = new Client({ connectionString: b.url, ...CONN });
    try { await src.connect(); }
    catch (e) { console.log(`  ⚠ suc ${b.code}: no conecta (${e.message.slice(0, 50)}) — skip`); continue; }
    try {
      for (const table of TABLES) {
        try { summary.push(await syncOneTable(ctrl, src, b, table, { apply, full })); }
        catch (e) { console.log(`  ✗ ${b.code}/${table}: ${e.message.slice(0, 90)}`); summary.push({ suc: b.code, tabla: table, error: e.message.slice(0, 45) }); }
      }
    } finally { await src.end().catch(() => {}); }
  }
  return summary;
}

(async () => {
  console.log(`\n=== replicate-ods-FAST — sucursales → kepler_ods (${APPLY ? 'APPLY' : 'DRY-RUN'}${FULL ? ', FULL' : ''}${WATCH_SEC ? `, WATCH ${WATCH_SEC}s` : ''}) ===`);
  console.log(`  sink: ${sink.sinkMode()}  ·  tablas: ${TABLES.join(', ')}${ONLY_BRANCH ? ` · solo suc ${ONLY_BRANCH}` : ''}`);

  let ctrl = new Client({ connectionString: CTRL_URL, ...CONN });
  await ctrl.connect();
  await ensureControl(ctrl);

  if (!WATCH_SEC) {
    const summary = await cycleAll(ctrl, { apply: APPLY, full: FULL });
    console.log('\n=== Resumen ===');
    console.table(summary.slice(0, 200));
    console.log(APPLY ? 'APPLY hecho.' : 'DRY-RUN — nada cambió. Corré con --apply.');
    await ctrl.end();
    return;
  }

  // ---- modo watch: loop continuo (apply). Ctrl persistente; reconecta si se cae. ----
  console.log(`  watch activo — Ctrl+C para salir.`);
  let cycle = 0;
  for (;;) {
    cycle++;
    const t0 = Date.now();
    try {
      const summary = await cycleAll(ctrl, { apply: true, full: FULL && cycle === 1 });
      const wrote = summary.reduce((a, r) => a + (r.escritas || 0), 0);
      if (wrote) console.log(`  ── ciclo ${cycle}: ${wrote} filas escritas (${Date.now() - t0}ms) ──`);
    } catch (e) {
      console.error(`  ✗ ciclo ${cycle}: ${e.message.slice(0, 120)}`);
      try { await ctrl.end().catch(() => {}); ctrl = new Client({ connectionString: CTRL_URL, ...CONN }); await ctrl.connect(); await ensureControl(ctrl); console.log('  (control reconectado)'); }
      catch (re) { console.error(`  ✗ reconexión control falló: ${re.message.slice(0, 80)}`); }
    }
    await sleep(WATCH_SEC * 1000);
  }
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
