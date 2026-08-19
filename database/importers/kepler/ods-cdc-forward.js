/* eslint-disable no-console */
/**
 * CDC forwarder — DRENAJE (parte 2 de 2). Lee `ods.change_queue` de cada replica (lo que el trigger
 * ALWAYS encoló al aplicar la replicación lógica) y empuja SOLO ese delta a prod (kepler_ods) por
 * feeds-ingest (raw-upsert). Sin re-leer tablas completas → todas las 335 quedan frescas casi al
 * segundo, sin el re-scan del carril hash.
 *
 * I/U → raw-upsert (UPSERT por PK, auto-crea tabla). D → diferido (Kepler casi no hace hard-delete;
 * se cuentan y se drenan; el barrido hash ocasional reconcilia). Dedup por PK dentro del lote
 * (última versión gana) para no chocar el ON CONFLICT.
 *
 *   node database/importers/kepler/ods-cdc-forward.js --apply             # una pasada
 *   node database/importers/kepler/ods-cdc-forward.js --apply --watch=5   # loop cada 5s
 *   node database/importers/kepler/ods-cdc-forward.js --apply --branch=02
 */
const { Client } = require('pg');
const sink = require('../lib/sink');

const APPLY = process.argv.includes('--apply');
const ONLY_BRANCH = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null;
const WATCH_ARG = process.argv.find((a) => a.startsWith('--watch'));
const WATCH_SEC = WATCH_ARG ? Math.max(2, Number(WATCH_ARG.split('=')[1] || 5)) : 0;
const BATCH = Math.max(200, Number(process.env.ODS_CDC_BATCH) || 2000);
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SUB_BASE = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const BRANCH_CODES = (process.env.ODS_LIVE_BRANCHES || '01,02,03,04,05,06').split(',').map((s) => s.trim()).filter(Boolean);
const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const localUrl = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return u.toString(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mapType(dt) {
  switch (dt) {
    case 'numeric': case 'double precision': case 'real': case 'integer':
    case 'bigint': case 'smallint': case 'boolean': case 'date': return dt;
    case 'timestamp without time zone': return 'timestamp';
    case 'timestamp with time zone': return 'timestamptz';
    default: return 'text';
  }
}
const metaCache = new Map(); // `${code}|${table}` → {cols, pk}
async function tableMeta(c, code, table) {
  const key = `${code}|${table}`;
  if (metaCache.has(key)) return metaCache.get(key);
  const cols = (await c.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='md' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
  if (!cols.length) { metaCache.set(key, null); return null; }
  const pk = (await c.query(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid=('md.'||$1)::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)`, [table])).rows.map((r) => r.attname);
  const m = { cols, pk };
  metaCache.set(key, m);
  return m;
}

/** Una pasada de drenaje para una rama. Devuelve {shipped, deleted, remaining}. */
async function drainBranch(code) {
  const c = new Client({ connectionString: localUrl(code), connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  try { await c.connect(); } catch { return { code, err: 'no conecta' }; }
  let shipped = 0, del = 0;
  try {
    // ¿existe la cola? (si no corrió el setup, skip)
    const has = (await c.query(`SELECT to_regclass('ods.change_queue') r`)).rows[0].r;
    if (!has) { return { code, err: 'sin cola (correr setup)' }; }

    for (;;) {
      const batch = (await c.query(
        `SELECT id, table_name, op, row_json FROM ods.change_queue ORDER BY id LIMIT ${BATCH}`)).rows;
      if (!batch.length) break;
      const maxId = batch[batch.length - 1].id;
      const delIds = batch.filter((r) => r.op === 'D').map((r) => r.id);
      del += delIds.length; // D diferido: se cuentan y se drenan (no se aplican aún)

      // agrupa I/U por tabla, dedup por PK (última gana, id ascendente)
      const tables = new Map();
      for (const r of batch) {
        if (r.op === 'D') continue;
        const meta = await tableMeta(c, code, r.table_name);
        if (!meta || !meta.pk.length) continue;
        const pkText = meta.pk.map((k) => String(r.row_json[k] ?? '\x00')).join('|');
        if (!tables.has(r.table_name)) tables.set(r.table_name, { meta, rows: new Map() });
        tables.get(r.table_name).rows.set(pkText, r.row_json); // última gana (id ascendente)
      }

      if (APPLY) {
        for (const [table, { meta, rows }] of tables) {
          const shipMeta = { table, pk: meta.pk, columns: [{ name: 'sucursal', type: 'text' }, ...meta.cols.map((cc) => ({ name: cc.column_name, type: mapType(cc.data_type) }))] };
          const list = [...rows.values()].map((rj) => ({ sucursal: code, ...rj }));
          await sink.ship('raw-upsert', { rows: list, tenantId: TENANT, meta: shipMeta });
          shipped += list.length;
        }
        // drena el lote entero (I/U aplicados + D contados)
        await c.query(`DELETE FROM ods.change_queue WHERE id <= $1`, [maxId]);
      } else {
        console.log(`  [DRY-RUN] ${code}: ${batch.length} en cola (${tables.size} tablas) — no se aplicó`);
        break;
      }
    }
    const remaining = (await c.query('SELECT count(*) n FROM ods.change_queue')).rows[0].n;
    return { code, shipped, deleted: del, remaining: Number(remaining) };
  } catch (e) { return { code, err: e.message.slice(0, 90), shipped }; }
  finally { await c.end().catch(() => {}); }
}

(async () => {
  console.log(`\n=== ods-cdc-forward (${APPLY ? 'APPLY' : 'DRY-RUN'}${WATCH_SEC ? `, WATCH ${WATCH_SEC}s` : ''}) · sink: ${sink.sinkMode()} ===`);
  do {
    const summary = [];
    for (const code of BRANCH_CODES) {
      if (ONLY_BRANCH && code !== ONLY_BRANCH) continue;
      summary.push(await drainBranch(code));
    }
    const line = summary.map((s) => s.err ? `${s.code}:${s.err}` : `${s.code}:↑${s.shipped}${s.deleted ? ` D${s.deleted}` : ''}${s.remaining ? ` (quedan ${s.remaining})` : ''}`).join('  ·  ');
    console.log(`  ${new Date().toISOString().slice(11, 19)}  ${line}`);
    if (WATCH_SEC) await sleep(WATCH_SEC * 1000);
  } while (WATCH_SEC);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
