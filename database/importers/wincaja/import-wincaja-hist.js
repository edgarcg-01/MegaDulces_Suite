/* eslint-disable no-console */
'use strict';
/**
 * Fase WR-hist — CARGA ONE-SHOT del histórico Wincaja (Access 97 por año) → Postgres local.
 *
 * Hermano del carril vivo `replicate-wincaja-live.js`, con cuatro diferencias de fondo:
 *
 *  1. NO es CDC: cada (sucursal, corte) se carga una vez y no vuelve a cambiar. Idempotente por
 *     ledger (`ods.wincaja_hist_load`) → re-correr salta lo ya hecho salvo `--force`.
 *
 *  2. **El corte (`_dataset`) es parte de la IDENTIDAD.** Cada carpeta `<año>` es el corte de ESE
 *     año y el `Consecutivo` REINICIA en 1 cada año (verificado suc 32: 2021 → 1..89,586 · 2025 →
 *     1..129,760, tickets distintos con el mismo número). Sin el año en el conflict target los años
 *     se pisan entre sí en silencio. Ver `wincaja-hist-config.js`.
 *
 *  3. **Copia local antes de leer.** Un scan sobre `Z:\...\2017\30 MORELIA ABASTOS.MDB` (559 MB) por
 *     SMB llevaba >17 min sin terminar; sobre copia local, segundos. La copia va a ~5.2 MB/s medidos.
 *
 *  4. **Lee con mdbtools, no con Jet, y escribe con COPY, no con INSERT.** Medido sobre el mismo
 *     archivo (`2025/44 YURECUARO.MDB`, 470k filas): el carril Jet+PS32+INSERT tardó **554 s**; el
 *     export de las 70 tablas con mdbtools tarda **67 s** (8.3x) con fidelidad exacta al centavo
 *     (152,718 filas · ΣValorVenta $7,629,584.75, idénticos). El cuello era `ConvertTo-Json` por
 *     fila en PowerShell, no Postgres. El pipeline queda: `mdb-export` → `psql \copy` → staging
 *     UNLOGGED → un solo `INSERT..SELECT` con el hash calculado server-side. Cero trabajo por fila
 *     en Node. El carril VIVO sigue con Jet (probado en prod bajo PM2) — acá no se toca.
 *     `--reader=jet` deja el camino viejo disponible por si algún `.mdb` viejo le cae mal a mdbtools.
 *
 * Destino: `:5433/wincaja`, schemas `hNN` (el carril vivo usa `wNN` — no se pisan).
 *
 * Uso:
 *   node database/importers/wincaja/import-wincaja-hist.js                          # dry-run: plan + volumen
 *   node database/importers/wincaja/import-wincaja-hist.js --year=2025 --branch=44 --apply
 *   node database/importers/wincaja/import-wincaja-hist.js --apply                  # todo, reciente→viejo
 *   node database/importers/wincaja/import-wincaja-hist.js --apply --limit=3        # de a poco
 *   WINCAJA_HIST_YEARS=Actuales node ... --apply                                    # otra carpeta-corte
 *
 * Flags: --apply · --year=YYYY | --years=a,b · --branch=NN | --branches=a,b · --only=Tabla1,Tabla2
 *        --force (recarga lo ya marcado ok) · --limit=N (unidades) · --keep-stage · --no-stage
 *        --reader=mdbtools|jet (default mdbtools)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { Client } = require('pg');

const A = require(path.join(__dirname, '..', 'lib', 'access-adapter'));
const M = require(path.join(__dirname, '..', 'lib', 'mdb-tools'));
const { mirrorDDL, conflictTarget, dataColumns, q, HK_HASH } = require(path.join(__dirname, '..', 'lib', 'access-mirror'));
const CFG = require('./wincaja-hist-config');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
const listOf = (name) => { const v = val(name); return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null; };

const APPLY = has('--apply');
const FORCE = has('--force');
const KEEP_STAGE = has('--keep-stage');
const NO_STAGE = has('--no-stage');
const LIMIT = Number(val('limit')) || 0;
const YEARS = listOf('years') || (val('year') ? [val('year')] : null);
const BRANCHES = listOf('branches') || (val('branch') ? [val('branch')] : null);
const ONLY = listOf('only') ? new Set(listOf('only')) : null;
const READER = (val('reader') || 'mdbtools').toLowerCase();

const EXTRA = ['_dataset'];
const STG_SCHEMA = 'zstg';

/**
 * IDENTIDAD DEL CARRIL HISTÓRICO = siempre el surrogate `(_dataset, _row_hash)`, nunca la PK
 * natural que declara el origen.
 *
 * Por qué (vivido 2026-09-01, primera unidad de la corrida): mdbtools reporta que
 * `ArticulosRelacion` tiene PK sobre `CodigoBarras`, y **los propios datos la violan** — hay filas
 * con NULL ahí. Access declara índices que su contenido no respeta, y el espejo CRUDO no está para
 * discutirle a la fuente: está para copiarla. Con PK natural la tabla entera se cae; con surrogate
 * entra tal cual.
 *
 * Se puede porque este carril es un APPEND de cortes inmutables: no hay UPDATE que aplicar, así que
 * nadie necesita la PK natural como conflict target (el carril VIVO sí la usa, y ahí se queda).
 * La PK que declaraba el origen no se pierde: se anota en el COMMENT de la tabla.
 * Efecto lateral aceptado, el mismo del carril vivo (FASE_WR §12): dos filas byte-idénticas dentro
 * de un corte colapsan en una.
 */
const surrogate = (t) => ({ ...t, pk: [] });
const PARAM_CAP = 60000; // margen bajo el límite de 65535 parámetros por sentencia (sólo carril jet)
const PSQL = process.env.PSQL_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';

/* ───────────────────────────── ledger de carga ───────────────────────────── */

async function ensureLedger(c) {
  await c.query('CREATE SCHEMA IF NOT EXISTS ods');
  await c.query(`CREATE TABLE IF NOT EXISTS ods.wincaja_hist_load (
    schema_name  text NOT NULL,
    dataset      text NOT NULL,
    table_name   text NOT NULL,
    mdb_file     text,
    rows_read    bigint,
    rows_written bigint,
    status       text NOT NULL,
    error        text,
    seconds      numeric,
    reader       text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (schema_name, dataset, table_name)
  )`);
  await c.query('ALTER TABLE ods.wincaja_hist_load ADD COLUMN IF NOT EXISTS reader text');
  await c.query(`COMMENT ON TABLE ods.wincaja_hist_load IS
    'Fase WR-hist: qué (sucursal, corte, tabla) del histórico Wincaja ya se cargó. Hace la carga reanudable e idempotente: una fila status=ok se salta salvo --force. La columna reader importa: el _row_hash de las tablas SIN PK depende del lector (mdbtools lo calcula server-side con md5(fila), Jet lo calculaba en JS), así que recargar con otro lector requiere --force, que borra la partición antes de insertar.'`);
  await c.query(`CREATE SCHEMA IF NOT EXISTS ${q(STG_SCHEMA)}`);
  await c.query(`COMMENT ON SCHEMA ${q(STG_SCHEMA)} IS
    'Staging efímero del carril WR-hist: tablas UNLOGGED todo-texto que recibe el COPY antes de castear al espejo. Se crean y se tiran por tabla; si queda algo acá es que una carga murió a la mitad.'`);
}

async function doneTables(c, schema, dataset) {
  const r = await c.query(
    `SELECT table_name FROM ods.wincaja_hist_load WHERE schema_name=$1 AND dataset=$2 AND status='ok'`, [schema, dataset]);
  return new Set(r.rows.map((x) => x.table_name));
}

async function markTable(c, schema, dataset, table, mdbFile, o) {
  await c.query(`INSERT INTO ods.wincaja_hist_load
      (schema_name, dataset, table_name, mdb_file, rows_read, rows_written, status, error, seconds, reader, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
    ON CONFLICT (schema_name, dataset, table_name) DO UPDATE SET
      mdb_file=excluded.mdb_file, rows_read=excluded.rows_read, rows_written=excluded.rows_written,
      status=excluded.status, error=excluded.error, seconds=excluded.seconds, reader=excluded.reader, updated_at=now()`,
    [schema, dataset, table, mdbFile, o.read ?? null, o.wrote ?? null, o.status, o.error ?? null, o.seconds ?? null, READER]);
}

/**
 * `--force` = recarga LIMPIA: borra la partición del corte antes de insertar. No es cosmético —
 * el `_row_hash` de las tablas sin PK depende del lector, así que un re-load con otro lector sin
 * borrar dejaría las filas viejas Y las nuevas (duplicado silencioso). Con PK natural el UPSERT
 * pisaría igual, pero borrar deja el corte reproducible tabla por tabla.
 */
async function clearPartition(c, schema, table, dataset) {
  const ex = await c.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2', [schema, table]);
  if (!ex.rowCount) return 0;
  const r = await c.query(`DELETE FROM ${q(schema)}.${q(table)} WHERE _dataset = $1`, [dataset]);
  return r.rowCount || 0;
}

/* ───────────────────────────── DDL espejo + drift ───────────────────────────── */

/**
 * Crea la tabla espejo si falta y RECONCILIA el drift de esquema entre cortes: un año puede traer
 * columnas que otro no tenía (Wincaja cambió de versión a lo largo de 9 años). Regla: se agregan las
 * que falten y, si el tipo choca, se ENSANCHA a `text` (nunca se angosta — perder un valor por un
 * cast es peor que guardarlo como texto; el saneamiento vive en silver).
 */
async function ensureTable(c, schema, t) {
  const ddl = mirrorDDL(schema, surrogate(t), { extraKeys: EXTRA });
  if (!ddl) return { created: false, added: [], widened: [] };
  const before = await c.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`,
    [schema, t.table]);
  await c.query(ddl);
  if (!before.rowCount) {
    // La PK que declaraba Access no se usa como identidad, pero es información: queda anotada.
    // OJO: `COMMENT ON` es sentencia de UTILIDAD → NO acepta parámetros ($1). Hay que interpolar
    // el literal escapado (pisar esto costó 70 tablas con "syntax error at or near $1").
    const pk = (t.pk || []).filter(Boolean);
    const txt = 'Espejo crudo Wincaja (Fase WR-hist). Identidad = (_dataset, _row_hash); _dataset es '
      + 'el corte (carpeta de origen), y el Consecutivo REINICIA cada año, por eso va en la identidad. '
      + `PK declarada en Access: ${pk.length ? pk.join(', ') : '(ninguna)'} — no se usa como `
      + 'restricción porque el origen la viola (hay NULLs en columnas de PK).';
    await c.query(`COMMENT ON TABLE ${q(schema)}.${q(t.table)} IS '${txt.replace(/'/g, "''")}'`);
    return { created: true, added: [], widened: [] };
  }

  const existing = new Map(before.rows.map((r) => [r.column_name, r.data_type]));
  const added = []; const widened = [];
  for (const col of (t.columns || []).filter((x) => x && x.name)) {
    const want = col.pg || A.jetToPg(col.jet);
    const have = existing.get(col.name);
    if (!have) {
      await c.query(`ALTER TABLE ${q(schema)}.${q(t.table)} ADD COLUMN IF NOT EXISTS ${q(col.name)} ${want}`);
      added.push(col.name);
    } else if (want === 'text' && have !== 'text') {
      await c.query(`ALTER TABLE ${q(schema)}.${q(t.table)} ALTER COLUMN ${q(col.name)} TYPE text USING ${q(col.name)}::text`);
      widened.push(`${col.name}:${have}→text`);
    }
  }
  return { created: false, added, widened };
}

/* ───────────── carril mdbtools: mdb-export → psql \copy → INSERT..SELECT ───────────── */

/** Parte la URL de Postgres en las piezas que necesita psql (la password va por env, no por argv). */
function pgParts(url) {
  const u = new URL(url);
  return {
    host: u.hostname, port: u.port || '5432',
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    db: decodeURIComponent((u.pathname || '/postgres').slice(1)),
  };
}

/**
 * `psql \copy <tabla> FROM '<csv>' CSV HEADER`. El CSV lo dejó `dumpAll` (un solo contenedor por
 * archivo). Devuelve las filas que reportó el COPY.
 *
 * OJO: sin `-q`. Con `-q` psql se calla el "COPY n" y el conteo de filas volvía 0 en todas las
 * tablas — la carga estaba bien, el reporte mentía.
 */
function copyCsv(pg, csvPath, stgQualified) {
  return new Promise((resolve, reject) => {
    const psql = spawn(PSQL, [
      '-v', 'ON_ERROR_STOP=1', '--no-psqlrc',
      '-h', pg.host, '-p', pg.port, '-U', pg.user, '-d', pg.db,
      '-c', `\\copy ${stgQualified} FROM '${csvPath.replace(/\\/g, '/')}' WITH (FORMAT csv, HEADER true)`,
    ], { env: { ...process.env, PGPASSWORD: pg.password }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let out = ''; let err = '';
    psql.stdout.on('data', (d) => { out += d; });
    psql.stderr.on('data', (d) => { err += d; });
    psql.on('error', (e) => reject(new Error(`psql no arrancó (${PSQL}): ${e.message}`)));
    psql.on('close', (code) => {
      if (code !== 0) return reject(new Error(`psql \\copy falló: ${(err || out).trim().slice(0, 300)}`));
      const m = /COPY\s+(\d+)/i.exec(out) || /COPY\s+(\d+)/i.exec(err);
      resolve(m ? Number(m[1]) : 0);
    });
  });
}

/** Expresión de cast del staging (todo texto) al tipo del espejo. */
function castExpr(col) {
  const ref = `s.${q(col.name)}`;
  if (col.pg === 'numeric' || col.pg === 'boolean') return `NULLIF(btrim(${ref}), '')::${col.pg}`;
  return ref;
}

/**
 * Carga una tabla por el carril mdbtools. Un COPY + un INSERT..SELECT; el `_row_hash` se calcula
 * server-side (`md5(s::text)` sobre la fila del staging) → cero hashing por fila en Node.
 */
async function loadTableCopy(c, pg, u, desc, csvPath) {
  const cols = desc.columns;
  const stgName = `${u.schema}__${desc.table}`;
  const stg = `${q(STG_SCHEMA)}.${q(stgName)}`;
  await c.query(`DROP TABLE IF EXISTS ${stg}`);
  await c.query(`CREATE UNLOGGED TABLE ${stg} (${cols.map((cc) => `${q(cc.name)} text`).join(', ')})`);
  try {
    const read = await copyCsv(pg, csvPath, `${STG_SCHEMA}.${JSON.stringify(stgName)}`);
    const conflict = conflictTarget(surrogate(desc), { extraKeys: EXTRA }); // → (_dataset, _row_hash)
    const res = await c.query(
      `INSERT INTO ${q(u.schema)}.${q(desc.table)} (${[...EXTRA, ...cols.map((cc) => cc.name), HK_HASH].map(q).join(', ')})
       SELECT $1, ${cols.map(castExpr).join(', ')}, md5(s::text)
         FROM ${stg} s
       ON CONFLICT (${conflict.map(q).join(', ')}) DO NOTHING`, [u.dataset]);
    return { read, wrote: res.rowCount || 0 };
  } finally {
    await c.query(`DROP TABLE IF EXISTS ${stg}`).catch(() => { /* noop */ });
  }
}

/* ───────────── carril jet (fallback): PS32 → JSONL en streaming → INSERT ───────────── */

function buildUpsertJet(schema, table, cols, conflict, batchRows) {
  const insertCols = [...EXTRA, ...cols, HK_HASH];
  const ph = (r) => '(' + insertCols.map((_, j) => `$${r * insertCols.length + j + 1}`).join(', ') + ')';
  const values = Array.from({ length: batchRows }, (_, r) => ph(r)).join(', ');
  // Identidad surrogate siempre (ver `surrogate` arriba) → DO NOTHING, sin rama de UPSERT.
  return `INSERT INTO ${q(schema)}.${q(table)} (${insertCols.map(q).join(', ')}) VALUES ${values} `
    + `ON CONFLICT (${conflict.map(q).join(', ')}) DO NOTHING`;
}

function pick(row, cols) { const o = {}; for (const k of cols) o[k] = row[k] === undefined ? null : row[k]; return o; }

async function flushJet(c, schema, table, cols, conflict, dataset, rows) {
  if (!rows.length) return 0;
  const sql = buildUpsertJet(schema, table, cols, conflict, rows.length);
  const params = [];
  for (const row of rows) {
    params.push(dataset);
    for (const k of cols) params.push(row[k] === undefined ? null : row[k]);
    params.push(A.rowHash(pick(row, cols)));
  }
  const res = await c.query(sql, params);
  return res.rowCount || 0;
}

/** Un solo scan Jet → JSONL a temp → se consume línea por línea (memoria constante). */
async function streamTableJet(mdb, table, onBatch, batchRows) {
  const out = path.join(os.tmpdir(), `wcj_h_${process.pid}_${Date.now()}.jsonl`);
  const res = spawnSync(A.PS32, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', A.READ_PS,
    '-Mdb', mdb, '-Table', table, '-Columns', '*', '-Out', out],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (res.error || res.status !== 0) {
    try { fs.unlinkSync(out); } catch { /* noop */ }
    throw new Error(`Jet falló en ${table}: ${(res.error?.message || res.stderr || res.stdout || '').slice(0, 300)}`);
  }
  let read = 0; let wrote = 0; let buf = [];
  try {
    if (!fs.existsSync(out)) return { read: 0, wrote: 0 };
    const rl = readline.createInterface({ input: fs.createReadStream(out, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      read++; buf.push(row);
      if (buf.length >= batchRows) { wrote += await onBatch(buf); buf = []; }
    }
    if (buf.length) wrote += await onBatch(buf);
  } finally { try { fs.unlinkSync(out); } catch { /* noop */ } }
  return { read, wrote };
}

/* ───────────────────────────── una unidad (sucursal × corte) ───────────────────────────── */

async function loadUnit(c, pg, u) {
  const useStage = !NO_STAGE || READER !== 'jet'; // mdbtools escribe los CSV junto al .mdb → staging obligatorio
  let local = u.mdb;
  let staged = false;
  let dump = null;
  const t0 = Date.now();

  if (useStage) {
    fs.mkdirSync(CFG.STAGE, { recursive: true });
    local = path.join(CFG.STAGE, `${u.schema}_${u.dataset}${path.extname(u.file) || '.mdb'}`);
    const tc = Date.now();
    fs.copyFileSync(u.mdb, local);
    staged = true;
    console.log(`  copia local ${u.sizeMB} MB en ${((Date.now() - tc) / 1000).toFixed(1)}s`);
  }

  try {
    // Descubrimiento + volcado. Con mdbtools va TODO en un solo contenedor: arrancar uno por tabla
    // costaba ~4 min por archivo (70 tablas × 2 llamadas × ~1.5 s) y anulaba la ventaja del lector.
    let descs;
    if (READER === 'jet') {
      descs = A.discoverSchema(local).filter((t) => (t.columns || []).length)
        .map((t) => ({ ...t, columns: t.columns.map((cc) => ({ ...cc, pg: A.jetToPg(cc.jet) })) }));
      console.log(`  jet: ${descs.length} tablas`);
    } else {
      const td = Date.now();
      dump = M.dumpAll(local, `${u.schema}_${u.dataset}_csv`);
      console.log(`  mdbtools ${dump.jet}: ${dump.tables.length} tablas volcadas en ${((Date.now() - td) / 1000).toFixed(1)}s`
        + (dump.errors.length ? ` · ⚠️ ${dump.errors.length} fallaron: ${dump.errors.join(', ').slice(0, 120)}` : ''));
      descs = dump.tables
        .map((t, i) => ({ ...M.describeFromCsv(t, dump.csvOf(i), dump.schema), csv: dump.csvOf(i) }))
        .filter((d) => d.columns.length && d.columns[0].name);
    }
    const tables = descs.filter((t) => !ONLY || ONLY.has(t.table));

    if (!APPLY) {
      console.log(`  DRY-RUN — no se escribe. Tablas: ${tables.slice(0, 8).map((t) => t.table).join(', ')}${tables.length > 8 ? ` … +${tables.length - 8}` : ''}`);
      return { tables: tables.length, read: 0, wrote: 0, errors: 0 };
    }

    await c.query(`CREATE SCHEMA IF NOT EXISTS ${q(u.schema)}`);
    const done = FORCE ? new Set() : await doneTables(c, u.schema, u.dataset);
    let totRead = 0; let totWrote = 0; let errors = 0; let skipped = 0;

    for (const t of tables) {
      if (done.has(t.table)) { skipped++; continue; }
      const tt = Date.now();
      try {
        const meta = await ensureTable(c, u.schema, t);
        if (meta.added.length) console.log(`    + columnas nuevas en ${t.table}: ${meta.added.join(', ')}`);
        if (meta.widened.length) console.log(`    ~ ensanchadas en ${t.table}: ${meta.widened.join(', ')}`);
        if (FORCE) {
          const del = await clearPartition(c, u.schema, t.table, u.dataset);
          if (del) console.log(`    − ${t.table}: ${del.toLocaleString()} filas del corte ${u.dataset} borradas (recarga limpia)`);
        }

        let r;
        if (READER === 'jet') {
          const cols = dataColumns(t);
          const conflict = conflictTarget(surrogate(t), { extraKeys: EXTRA });
          const batchRows = Math.max(50, Math.min(500, Math.floor(PARAM_CAP / (cols.length + EXTRA.length + 1))));
          r = await streamTableJet(local, t.table, (rows) => flushJet(c, u.schema, t.table, cols, conflict, u.dataset, rows), batchRows);
        } else {
          r = await loadTableCopy(c, pg, u, t, t.csv);
        }
        const secs = (Date.now() - tt) / 1000;
        totRead += r.read; totWrote += r.wrote;
        await markTable(c, u.schema, u.dataset, t.table, u.file, { read: r.read, wrote: r.wrote, status: 'ok', seconds: secs });
        if (r.read) console.log(`    ${t.table.padEnd(28)} read=${String(r.read).padStart(8)} wrote=${String(r.wrote).padStart(8)} ${secs.toFixed(1)}s`);
      } catch (e) {
        errors++;
        console.warn(`    ⚠️  ${t.table}: ${e.message.slice(0, 220)}`);
        await markTable(c, u.schema, u.dataset, t.table, u.file, { status: 'error', error: e.message.slice(0, 500), seconds: (Date.now() - tt) / 1000 });
      }
    }
    console.log(`  → ${u.code}/${u.dataset}: read ${totRead.toLocaleString()} · wrote ${totWrote.toLocaleString()}`
      + `${skipped ? ` · ${skipped} ya cargadas` : ''}${errors ? ` · ${errors} con error` : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { tables: tables.length, read: totRead, wrote: totWrote, errors };
  } finally {
    if (!KEEP_STAGE) {
      if (dump) { try { fs.rmSync(dump.dir, { recursive: true, force: true }); } catch { /* noop */ } }
      if (staged) { try { fs.unlinkSync(local); } catch { /* noop */ } }
    }
  }
}

/* ───────────────────────────── main ───────────────────────────── */

(async () => {
  if (!fs.existsSync(CFG.HIST_BASE)) {
    console.error(`fuente inalcanzable: ${CFG.HIST_BASE}`);
    console.error('  ⚠️  si es una unidad mapeada (Z:), los mapeos de Windows son POR SESIÓN de login:');
    console.error('      preferí una ruta UNC (\\\\servidor\\share\\...) en WINCAJA_HIST_BASE.');
    process.exit(1);
  }
  const units0 = CFG.inventory({ years: YEARS || undefined, branches: BRANCHES || undefined, includeLive: has('--include-live') });
  const units = LIMIT ? units0.slice(0, LIMIT) : units0;
  const gb = (units.reduce((s, u) => s + u.sizeMB, 0) / 1024).toFixed(2);
  console.log(`\n=== Histórico Wincaja → ${CFG.REPLICA_URL.replace(/\/\/[^@]*@/, '//***@')} (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`fuente: ${CFG.HIST_BASE} · cortes: ${(YEARS || CFG.YEARS).join(',')} · lector: ${READER}`);
  console.log(`orden: lo de prod primero, reciente→viejo · unidades: ${units.length}${LIMIT ? ` (limit de ${units0.length})` : ''} · ${gb} GB`);
  console.log(`staging: ${NO_STAGE ? 'DIRECTO (lento)' : CFG.STAGE}\n`);
  if (!units.length) { console.log('nada que cargar — revisá --year/--branch y que la carpeta exista.'); return; }

  const pg = pgParts(CFG.REPLICA_URL);
  if (READER !== 'jet') {
    try { M.ensureImage(); } catch (e) { console.error(`mdbtools no disponible: ${e.message}`); console.error('  → arrancá Docker, o corré con --reader=jet'); process.exit(1); }
    if (!fs.existsSync(PSQL)) { console.error(`psql no encontrado en ${PSQL} — seteá PSQL_BIN`); process.exit(1); }
  }

  const c = new Client({ connectionString: CFG.REPLICA_URL, statement_timeout: 0 });
  await c.connect();
  let okUnits = 0; let totRead = 0; let totWrote = 0; let errUnits = 0;
  try {
    if (APPLY) await ensureLedger(c);
    for (const [i, u] of units.entries()) {
      console.log(`[${i + 1}/${units.length}] ${u.code} ${u.name} · corte ${u.dataset} · ${u.sizeMB} MB → ${u.schema}`);
      try {
        const r = await loadUnit(c, pg, u);
        totRead += r.read; totWrote += r.wrote;
        if (r.errors) errUnits++; else okUnits++;
      } catch (e) {
        errUnits++;
        console.error(`  ✖ ${u.code}/${u.dataset}: ${e.message.slice(0, 300)}`);
      }
    }
  } finally { await c.end(); }

  console.log(`\n=== fin: ${okUnits} unidades ok · ${errUnits} con problemas · read ${totRead.toLocaleString()} · wrote ${totWrote.toLocaleString()} ===`);
  if (!APPLY) console.log('(dry-run — volvé a correr con --apply para escribir)');
  if (errUnits) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
