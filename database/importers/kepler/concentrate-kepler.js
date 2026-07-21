/* eslint-disable no-console */
/**
 * KP_CONCENTRADA — ODS concentrado de TODAS las sucursales Kepler (ETL Node).
 *
 * Replica cada tabla `md.*` de cada sucursal (md_00..md_05) a
 * `KP_CONCENTRADA.kp.<tabla>` en 192.168.0.245, agregando columna `sucursal` +
 * `_loaded_at`. Schema-discovery: descubre tablas/columnas en runtime (soporta las
 * ~330 tablas sin config). Guarda el WATERMARK por (sucursal, tabla) en
 * `kp.sync_control` para saber "hasta cuándo" se cargó y refrescar incremental.
 *
 * Modo por tabla:
 *   - INCREMENTAL: si la tabla tiene una columna timestamp/date → carga con
 *     overlap-reload (DELETE where ts >= last_value; INSERT where ts >= last_value)
 *     → idempotente, sin duplicados ni huecos. last_value = MAX(ts) cargado.
 *   - FULL: si NO hay columna de fecha (catálogos) → reemplazo total por sucursal.
 *   Forzar full de todo con --full.
 *
 * Lectura sin OOM: keyset por `ctid` dentro de una trx REPEATABLE READ READ ONLY
 * (snapshot estable → ctid monótono, O(n), memoria acotada). Sin deps externas.
 *
 * Env:
 *   KP_DEST_URL     = postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA
 *   KP_BRANCH_MAP   = JSON [{code,url}] (default = las 6 sucursales; creds platform_ro/kepler123)
 *   KP_EXCLUDE      = csv de tablas a saltar (ej "kdmx_25,kdmx_26" para omitir XML pesado)
 *
 * Flags:
 *   --apply            aplica (default dry-run: solo plan)
 *   --full             fuerza reemplazo total de todas las tablas
 *   --branch=03        solo esa sucursal
 *   --tables=kdm1,kdii solo esas tablas (para pruebas)
 *   --create-db        crea la DB KP_CONCENTRADA si no existe (requiere permiso)
 *
 *   node database/importers/kepler/concentrate-kepler.js --tables=kdm_rutas          # dry-run
 *   node database/importers/kepler/concentrate-kepler.js --create-db --apply         # full run
 */

const { Client } = require('pg');

const DEST_URL = process.env.KP_DEST_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
const APPLY = process.argv.includes('--apply');
const FULL = process.argv.includes('--full');
const CREATE_DB = process.argv.includes('--create-db');
const ONLY_BRANCH = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null;
const ONLY_TABLES = (process.argv.find((a) => a.startsWith('--tables=')) || '').split('=')[1];
const TABLE_FILTER = ONLY_TABLES ? new Set(ONLY_TABLES.split(',').map((s) => s.trim())) : null;
const EXCLUDE = new Set((process.env.KP_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean));
const READ_BATCH = 5000;

const BRANCHES = process.env.KP_BRANCH_MAP
  ? JSON.parse(process.env.KP_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

// information_schema.data_type → tipo destino (preserva lo esencial; texto por default).
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
const isTsType = (dt) => dt === 'date' || dt === 'timestamp without time zone' || dt === 'timestamp with time zone';
const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';

async function ensureDatabase() {
  // Conecta a la DB de mantenimiento (postgres) para crear KP_CONCENTRADA.
  const adminUrl = DEST_URL.replace(/\/[^/]+$/, '/postgres');
  const dbName = decodeURIComponent(DEST_URL.replace(/^.*\//, ''));
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (r.rowCount) { console.log(`  DB ${dbName} ya existe.`); return; }
    if (!APPLY) { console.log(`  [DRY-RUN] crearía DB ${dbName}.`); return; }
    await c.query(`CREATE DATABASE ${qid(dbName)}`);
    console.log(`  DB ${dbName} creada.`);
  } finally { await c.end(); }
}

async function ensureBase(dest) {
  if (!APPLY) return;
  await dest.query('CREATE SCHEMA IF NOT EXISTS kp');
  await dest.query(`
    CREATE TABLE IF NOT EXISTS kp.sync_control (
      sucursal    text NOT NULL,
      table_name  text NOT NULL,
      ts_col      text,
      mode        text NOT NULL,
      last_value  timestamptz,
      last_run_at timestamptz NOT NULL DEFAULT now(),
      rows_last   integer DEFAULT 0,
      rows_total  bigint DEFAULT 0,
      PRIMARY KEY (sucursal, table_name)
    )`);
}

async function listTables(src) {
  const r = await src.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='md' AND table_type='BASE TABLE' ORDER BY table_name`);
  return r.rows.map((x) => x.table_name)
    .filter((t) => !EXCLUDE.has(t) && (!TABLE_FILTER || TABLE_FILTER.has(t)));
}

async function columns(src, table) {
  const r = await src.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='md' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  return r.rows;
}

/** Crea kp.<table> si no existe; agrega columnas faltantes si difieren entre sucursales. */
async function ensureDestTable(dest, table, cols) {
  const exists = (await dest.query(`SELECT to_regclass('kp.${table.replace(/'/g, "''")}') AS t`)).rows[0].t;
  if (!exists) {
    const defs = cols.map((c) => `${qid(c.column_name)} ${mapType(c.data_type)}`).join(', ');
    await dest.query(`CREATE TABLE kp.${qid(table)} (sucursal text NOT NULL, ${defs}, _loaded_at timestamptz DEFAULT now())`);
    await dest.query(`CREATE INDEX ${qid('ix_kp_' + table + '_suc')} ON kp.${qid(table)} (sucursal)`);
    return;
  }
  const have = new Set((await dest.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='kp' AND table_name=$1`, [table]
  )).rows.map((r) => r.column_name));
  for (const c of cols) {
    if (!have.has(c.column_name)) {
      await dest.query(`ALTER TABLE kp.${qid(table)} ADD COLUMN ${qid(c.column_name)} ${mapType(c.data_type)}`);
    }
  }
}

/** Elige la columna timestamp/date "de actividad" (la de MAX más reciente).
 * Clampa a now() para que una fila con fecha basura futura no domine la elección. */
async function pickTsCol(src, table, cols) {
  const cands = cols.filter((c) => isTsType(c.data_type)).map((c) => c.column_name);
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  let best = null, bestMax = null;
  for (const col of cands) {
    try {
      const r = await src.query(`SELECT max(${qid(col)}) AS m FROM md.${qid(table)} WHERE ${qid(col)} <= now()`);
      const m = r.rows[0].m;
      if (m && (bestMax === null || new Date(m) > new Date(bestMax))) { bestMax = m; best = col; }
    } catch { /* ignora columna problemática */ }
  }
  return best || cands[0];
}

/** Copia filas de md.<table> (branch) → kp.<table>, keyset por ctid (snapshot RR). */
async function copyRows(src, dest, table, cols, branch, whereSql, whereParams) {
  const colNames = cols.map((c) => c.column_name);
  const selList = colNames.map(qid).join(', ');
  const insCols = ['sucursal', ...colNames].map(qid).join(', ');
  const perRow = colNames.length + 1;
  const insBatch = Math.max(1, Math.floor(60000 / perRow));

  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  let total = 0;
  try {
    let lastCtid = '(0,0)';
    for (;;) {
      const q = `SELECT ctid, ${selList} FROM md.${qid(table)}
                 WHERE ctid > $1::tid ${whereSql ? 'AND ' + whereSql : ''}
                 ORDER BY ctid LIMIT ${READ_BATCH}`;
      const rows = (await src.query(q, [lastCtid, ...(whereParams || [])])).rows;
      if (!rows.length) break;
      lastCtid = rows[rows.length - 1].ctid;

      for (let i = 0; i < rows.length; i += insBatch) {
        const chunk = rows.slice(i, i + insBatch);
        const vals = [], params = [];
        chunk.forEach((row, ri) => {
          const b = ri * perRow;
          const ph = [`$${b + 1}`];
          params.push(branch);
          colNames.forEach((cn, ci) => { ph.push(`$${b + 2 + ci}`); params.push(row[cn]); });
          vals.push(`(${ph.join(',')})`);
        });
        await dest.query(`INSERT INTO kp.${qid(table)} (${insCols}) VALUES ${vals.join(',')}`, params);
      }
      total += rows.length;
    }
    await src.query('COMMIT');
  } catch (e) {
    await src.query('ROLLBACK').catch(() => {});
    throw e;
  }
  return total;
}

(async () => {
  console.log(`\n=== KP_CONCENTRADA — concentrador Kepler (${APPLY ? 'APPLY' : 'DRY-RUN'}${FULL ? ', FULL' : ''}) ===`);
  console.log(`  destino: ${DEST_URL.replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`  sucursales: ${BRANCHES.map((b) => b.code).join(', ')}${ONLY_BRANCH ? ` (solo ${ONLY_BRANCH})` : ''}`);
  if (TABLE_FILTER) console.log(`  tablas: ${[...TABLE_FILTER].join(', ')}`);
  if (EXCLUDE.size) console.log(`  excluye: ${[...EXCLUDE].join(', ')}`);

  if (CREATE_DB) { console.log('\n-- Verificar/crear DB --'); await ensureDatabase(); }

  const dest = new Client({ connectionString: DEST_URL });
  try { await dest.connect(); }
  catch (e) { console.error(`\nNo conecta al destino KP_CONCENTRADA: ${e.message}\n(¿existe la DB? corré con --create-db --apply)`); process.exit(1); }
  await ensureBase(dest);

  const summary = [];
  for (const b of BRANCHES) {
    if (ONLY_BRANCH && b.code !== ONLY_BRANCH) continue;
    const src = new Client({ connectionString: b.url });
    try { await src.connect(); }
    catch (e) { console.log(`\n⚠ sucursal ${b.code}: no conecta (${e.message.slice(0, 60)}) — skip`); continue; }
    console.log(`\n── Sucursal ${b.code} ──`);
    try {
      const tables = await listTables(src);
      console.log(`  ${tables.length} tablas md.*`);
      for (const t of tables) {
        try {
          const cols = await columns(src, t);
          if (!cols.length) continue;
          const tsCol = await pickTsCol(src, t, cols);
          const mode = FULL || !tsCol ? 'full' : 'incremental';

          // Watermark previo.
          const wm = APPLY
            ? (await dest.query(`SELECT last_value FROM kp.sync_control WHERE sucursal=$1 AND table_name=$2`, [b.code, t])).rows[0]
            : null;
          const lastVal = mode === 'incremental' ? wm?.last_value || null : null;

          // Conteo a cargar (plan).
          let whereSql = null, whereParams = [];
          if (mode === 'incremental' && lastVal) { whereSql = `${qid(tsCol)} >= $2`; whereParams = [lastVal]; }
          const cntQ = `SELECT count(*)::bigint n FROM md.${qid(t)}${whereSql ? ' WHERE ' + whereSql.replace('$2', '$1') : ''}`;
          const toLoad = Number((await src.query(cntQ, whereParams)).rows[0].n);

          if (!APPLY) {
            summary.push({ suc: b.code, tabla: t, mode, ts: tsCol || '—', desde: lastVal ? new Date(lastVal).toISOString().slice(0, 10) : '(inicio)', filas: toLoad });
            continue;
          }

          await ensureDestTable(dest, t, cols);
          // Borrado idempotente antes de reinsertar (overlap para incremental).
          if (mode === 'full') {
            await dest.query(`DELETE FROM kp.${qid(t)} WHERE sucursal=$1`, [b.code]);
          } else if (lastVal) {
            await dest.query(`DELETE FROM kp.${qid(t)} WHERE sucursal=$1 AND ${qid(tsCol)} >= $2`, [b.code, lastVal]);
          } else {
            await dest.query(`DELETE FROM kp.${qid(t)} WHERE sucursal=$1`, [b.code]); // primer load
          }

          const loaded = await copyRows(src, dest, t, cols, b.code, whereSql ? `${qid(tsCol)} >= $2` : null, whereParams);
          // Nuevo watermark = MAX(ts) REALISTA (<= now()) en destino para la sucursal.
          // Clamp a now(): una fila con fecha basura futura (visto en Kepler: 2106, 2029,
          // 2028) envenenaría el watermark y CONGELARÍA el incremental (nada vuelve a
          // cumplir ts >= last_value). Las filas futuras siguen cargándose (overlap), solo
          // no avanzan la marca de agua.
          let newMax = null;
          if (tsCol) {
            newMax = (await dest.query(`SELECT max(${qid(tsCol)}) m FROM kp.${qid(t)} WHERE sucursal=$1 AND ${qid(tsCol)} <= now()`, [b.code])).rows[0].m;
          }
          const rowsTotal = Number((await dest.query(`SELECT count(*)::bigint n FROM kp.${qid(t)} WHERE sucursal=$1`, [b.code])).rows[0].n);
          await dest.query(
            `INSERT INTO kp.sync_control (sucursal, table_name, ts_col, mode, last_value, last_run_at, rows_last, rows_total)
             VALUES ($1,$2,$3,$4,$5, now(), $6, $7)
             ON CONFLICT (sucursal, table_name) DO UPDATE SET
               ts_col=EXCLUDED.ts_col, mode=EXCLUDED.mode, last_value=EXCLUDED.last_value,
               last_run_at=now(), rows_last=EXCLUDED.rows_last, rows_total=EXCLUDED.rows_total`,
            [b.code, t, tsCol, mode, newMax, loaded, rowsTotal]);
          summary.push({ suc: b.code, tabla: t, mode, ts: tsCol || '—', cargadas: loaded, total: rowsTotal, hasta: newMax ? new Date(newMax).toISOString().slice(0, 10) : '—' });
        } catch (e) {
          console.log(`  ✗ ${t}: ${e.message.slice(0, 80)}`);
          summary.push({ suc: b.code, tabla: t, error: e.message.slice(0, 40) });
        }
      }
    } finally { await src.end(); }
  }

  console.log('\n=== Resumen ===');
  console.table(summary.slice(0, 400));
  console.log(`${summary.length} (sucursal×tabla). ${APPLY ? 'APPLY hecho.' : 'DRY-RUN — nada cambió. Corré con --apply.'}`);
  await dest.end();
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
