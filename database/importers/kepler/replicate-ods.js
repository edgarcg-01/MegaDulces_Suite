/* eslint-disable no-console */
/**
 * SYNC.2.2 — replicador CDC genérico KP_CONCENTRADA → prod kepler_ods.* (UPSERT sin churn).
 *
 * Etapa 2 del pipe (la etapa 1, sucursales→KP_CONCENTRADA, la hace concentrate-kepler.js).
 * Para cada tabla configurada:
 *   1) descubre columnas de kp.<tabla> y la PK del origen md.<tabla> (información genérica,
 *      cero config por tabla — las 348 tablas Kepler tienen PK),
 *   2) lee SOLO lo que concentrate tocó desde el último push (watermark sobre `_loaded_at`,
 *      columna universal de kp.*), keyset por ctid (sin OOM),
 *   3) lo empuja por el sink 'raw-upsert' (ingress GRATIS vía feeds-ingest; en prod el
 *      ON CONFLICT … WHERE IS DISTINCT FROM sólo escribe las filas que de verdad cambiaron).
 *
 * Watermark en kp.ods_push_control (en KP_CONCENTRADA). Sólo avanza si el push respondió OK.
 * Nunca lee prod → cero egress. UPSERT no propaga hard-deletes (raro en ERP; reconcile aparte
 * si alguna tabla lo necesita).
 *
 * Env:
 *   KP_SRC_URL      = KP_CONCENTRADA (default 192.168.0.245/KP_CONCENTRADA)
 *   KP_BRANCH_MAP   = JSON [{code,url}] para descubrir PK (default las 6 sucursales)
 *   KP_ODS_TABLES   = csv de tablas a replicar (default piloto 'kdm1,kdm2,kdii')
 *   FEEDS_SINK=http + FEEDS_INGEST_URL + FEEDS_INGEST_KEY   (o pg + DATABASE_URL_NEW para smoke local)
 *   CRON_TENANT_ID  = tenant (default Mega Dulces)
 *   ODS_READ_BATCH (5000) · ODS_SHIP_BATCH (5000)
 *
 * Flags: --apply (default dry-run) · --tables=kdm1,kdii · --full (ignora watermark, re-empuja todo)
 *
 *   node database/importers/kepler/replicate-ods.js --tables=kdii            # dry-run plan
 *   node database/importers/kepler/replicate-ods.js --tables=kdii --apply    # aplica
 */

const { Client } = require('pg');
const sink = require('../lib/sink');

const SRC_URL = process.env.KP_SRC_URL || process.env.KP_DEST_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const FULL = process.argv.includes('--full');
const ONLY = (process.argv.find((a) => a.startsWith('--tables=')) || '').split('=')[1];
const TABLES = (ONLY || process.env.KP_ODS_TABLES || 'kdm1,kdm2,kdii').split(',').map((s) => s.trim()).filter(Boolean);
const READ_BATCH = Math.max(500, Number(process.env.ODS_READ_BATCH) || 5000);
const SHIP_BATCH = Math.max(500, Number(process.env.ODS_SHIP_BATCH) || 5000);

const CONN = { connectionTimeoutMillis: 15000, statement_timeout: 300000, query_timeout: 300000, keepAlive: true };
// Fuente única del mapa de sucursales (paso 3 normalización almacén). Las 6 (incluye CEDIS).
const { stockMap } = require('../lib/kepler-branches');
const BRANCHES = process.env.KP_BRANCH_MAP ? JSON.parse(process.env.KP_BRANCH_MAP) : stockMap({ cedis: true });

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

/** Descubre la PK de cada md.<table> con fallback por-tabla entre sucursales (una tabla que
 * no vive en la suc 00 —p.ej. POS/pólizas— se busca en la siguiente que la tenga). */
async function discoverBranchMeta(tables) {
  const clients = [];
  for (const b of BRANCHES) {
    const c = new Client({ connectionString: b.url, ...CONN });
    try { await c.connect(); clients.push({ code: b.code, c }); } catch { /* suc caída — skip */ }
  }
  if (!clients.length) throw new Error('ninguna sucursal conecta para descubrir PK');
  console.log(`  sucursales conectadas para PK: ${clients.map((x) => x.code).join(', ')}`);
  const pk = {};
  const PK_SQL = `
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
    WHERE i.indrelid=('md.'||$1)::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`;
  try {
    for (const t of tables) {
      pk[t] = [];
      for (const { c } of clients) {
        const reg = await c.query(`SELECT to_regclass('md.'||$1) r`, [t]).then((r) => r.rows[0].r).catch(() => null);
        if (!reg) continue;
        const r = await c.query(PK_SQL, [t]).catch(() => ({ rows: [] }));
        if (r.rows.length) { pk[t] = r.rows.map((x) => x.attname); break; }
      }
    }
  } finally { for (const { c } of clients) await c.end().catch(() => {}); }
  return pk;
}

async function ensureControl(src) {
  await src.query(`
    CREATE TABLE IF NOT EXISTS kp.ods_push_control (
      table_name text PRIMARY KEY,
      last_loaded_at timestamptz,
      rows_last integer DEFAULT 0,
      changed_last integer DEFAULT 0,
      last_run_at timestamptz NOT NULL DEFAULT now()
    )`);
}

async function kpColumns(src, table) {
  const r = await src.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='kp' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  return r.rows;
}

(async () => {
  console.log(`\n=== replicate-ods — KP_CONCENTRADA → kepler_ods (${APPLY ? 'APPLY' : 'DRY-RUN'}${FULL ? ', FULL' : ''}) ===`);
  console.log(`  origen: ${SRC_URL.replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`  sink: ${sink.sinkMode()}  ·  tablas: ${TABLES.join(', ')}`);

  const pkByTable = await discoverBranchMeta(TABLES);

  const src = new Client({ connectionString: SRC_URL, ...CONN });
  await src.connect();
  // Cliente destino sólo para el smoke local en modo pg (en http lo ignora el sink).
  // Sólo se abre al aplicar; el dry-run no toca destino.
  let dstClient = null;
  if (APPLY && sink.sinkMode() === 'pg') {
    dstUrlCheck();
    dstClient = new Client({ connectionString: process.env.DATABASE_URL_NEW, ...CONN, ssl: sslFor(process.env.DATABASE_URL_NEW) });
    await dstClient.connect();
  }
  await ensureControl(src);

  const summary = [];
  for (const table of TABLES) {
    const pk = pkByTable[table] || [];
    try {
      if (!pk.length) { console.log(`  ✗ ${table}: sin PK en origen — skip`); summary.push({ tabla: table, error: 'sin PK' }); continue; }
      const cols = await kpColumns(src, table);
      if (!cols.length) { console.log(`  ✗ ${table}: no existe en kp.* (¿ya la concentró concentrate-kepler?)`); summary.push({ tabla: table, error: 'no en kp.*' }); continue; }
      const hasLoadedAt = cols.some((c) => c.column_name === '_loaded_at');

      // columnas de datos = todo menos _loaded_at (metadata de concentrate).
      const dataCols = cols.filter((c) => c.column_name !== '_loaded_at');
      if (!dataCols.some((c) => c.column_name === 'sucursal')) { console.log(`  ✗ ${table}: kp.${table} sin 'sucursal' — skip`); summary.push({ tabla: table, error: 'sin sucursal' }); continue; }
      const metaCols = dataCols.map((c) => ({ name: c.column_name, type: mapType(c.data_type) }));
      const selList = dataCols.map((c) => qid(c.column_name)).join(', ');

      // watermark.
      const wmRow = (await src.query(`SELECT last_loaded_at FROM kp.ods_push_control WHERE table_name=$1`, [table])).rows[0];
      const wm = FULL ? null : (wmRow && wmRow.last_loaded_at) || null;
      const whereWm = hasLoadedAt && wm ? `AND _loaded_at > $2` : '';

      // índice para lectura barata por _loaded_at (idempotente).
      if (hasLoadedAt && APPLY) {
        await src.query(`CREATE INDEX IF NOT EXISTS ${qid('ix_kp_' + table + '_loaded')} ON kp.${qid(table)} (_loaded_at)`).catch(() => {});
      }

      // conteo candidato (plan).
      const cntQ = `SELECT count(*)::bigint n${hasLoadedAt ? ', max(_loaded_at) mx' : ''} FROM kp.${qid(table)} WHERE true ${hasLoadedAt && wm ? 'AND _loaded_at > $1' : ''}`;
      const cntR = (await src.query(cntQ, hasLoadedAt && wm ? [wm] : [])).rows[0];
      const candidate = Number(cntR.n);

      if (!APPLY) {
        summary.push({ tabla: table, pk: pk.join(','), cols: dataCols.length, desde: wm ? new Date(wm).toISOString().slice(0, 19) : '(inicio)', candidatas: candidate });
        continue;
      }

      // Lectura keyset por ctid dentro de snapshot estable; ship por lotes.
      await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let lastCtid = '(0,0)', seen = 0, changed = 0, maxLoaded = wm, buf = [];
      const meta = { table, pk, columns: metaCols };
      const flush = async () => {
        if (!buf.length) return;
        const r = await sink.ship('raw-upsert', { rows: buf, tenantId: TENANT, client: dstClient, meta });
        changed += Number(r.rowCount || 0);
        buf = [];
      };
      try {
        for (;;) {
          const q = `SELECT ctid, ${selList}${hasLoadedAt ? ', _loaded_at' : ''} FROM kp.${qid(table)}
                     WHERE ctid > $1::tid ${whereWm} ORDER BY ctid LIMIT ${READ_BATCH}`;
          const rows = (await src.query(q, hasLoadedAt && wm ? [lastCtid, wm] : [lastCtid])).rows;
          if (!rows.length) break;
          lastCtid = rows[rows.length - 1].ctid;
          for (const row of rows) {
            if (hasLoadedAt && row._loaded_at && (!maxLoaded || new Date(row._loaded_at) > new Date(maxLoaded))) maxLoaded = row._loaded_at;
            const o = {};
            for (const c of dataCols) o[c.column_name] = row[c.column_name];
            buf.push(o);
            seen++;
            if (buf.length >= SHIP_BATCH) await flush();
          }
        }
        await flush();
        await src.query('COMMIT');
      } catch (e) {
        await src.query('ROLLBACK').catch(() => {});
        throw e;
      }

      // Avanza watermark SOLO tras push OK.
      await src.query(
        `INSERT INTO kp.ods_push_control (table_name, last_loaded_at, rows_last, changed_last, last_run_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (table_name) DO UPDATE SET last_loaded_at=EXCLUDED.last_loaded_at,
           rows_last=EXCLUDED.rows_last, changed_last=EXCLUDED.changed_last, last_run_at=now()`,
        [table, maxLoaded, seen, changed]);
      console.log(`  ✓ ${table}: ${seen} leídas · ${changed} escritas (cambiadas) · hasta ${maxLoaded ? new Date(maxLoaded).toISOString().slice(0, 19) : '—'}`);
      summary.push({ tabla: table, leidas: seen, escritas: changed, hasta: maxLoaded ? new Date(maxLoaded).toISOString().slice(0, 10) : '—' });
    } catch (e) {
      console.log(`  ✗ ${table}: ${e.message.slice(0, 100)}`);
      summary.push({ tabla: table, error: e.message.slice(0, 50) });
    }
  }

  console.log('\n=== Resumen ===');
  console.table(summary);
  console.log(APPLY ? 'APPLY hecho.' : 'DRY-RUN — nada cambió. Corré con --apply.');
  await src.end();
  if (dstClient) await dstClient.end();
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });

function dstUrlCheck() {
  if (!process.env.DATABASE_URL_NEW) throw new Error('FEEDS_SINK=pg requiere DATABASE_URL_NEW (destino kepler_ods)');
}
function sslFor(cs) {
  return /@(localhost|127\.0\.0\.1|192\.168\.|[^@/]*\.railway\.internal)/.test(cs || '') ? false : { rejectUnauthorized: false };
}
