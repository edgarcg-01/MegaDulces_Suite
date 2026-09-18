'use strict';
/**
 * MOTOR de RÉPLICA CRUDA Access → Postgres, compartido (ADR-056).
 *
 * Nació como `wincaja/replicate-wincaja-live.js` (Fase WR.3/WR.4) y se subió acá cuando la Fase CG
 * necesitó el mismo carril para `BDatos.mdb` (la base Dulcería/Kepler-viejo del Access `Control`).
 * Duplicar 295 líneas de un motor que ya está probado en producción es exactamente lo que ADR-056
 * prohíbe, así que el motor vive una sola vez y cada fuente aporta su CONFIG.
 *
 * Toda la lógica está verbatim de WR — incluidas las lecciones que ya se pagaron caro, que están
 * comentadas donde ocurren. El refactor se verificó con `--dry` antes y después contra las .mdb
 * reales de Wincaja: salida idéntica.
 *
 * Dos carriles, decididos POR TABLA:
 *   · INCREMENTAL — `WHERE <wm_col> > watermark`. Barato, acotado. Sólo legítimo si la columna de
 *     watermark es TODA la identidad de la tabla (ver `watermarkSeguro`).
 *   · HASH-DELTA  — full-scan → md5(fila) en JS → UPSERT sólo si el hash cambió. Captura UPDATES.
 *
 * On-prem only (Jet 32-bit + acceso al share). NO en Railway.
 *
 * Uso desde un wrapper:
 *   require('../lib/access-replicate').run(require('./mi-config'));
 */
const path = require('path');
const { Client } = require('pg');
const A = require(path.join(__dirname, 'access-adapter'));
const { conflictTarget, dataColumns, HK_HASH } = require(path.join(__dirname, 'access-mirror'));

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

/**
 * `PK_OVERRIDE` — declarar la identidad de una tabla que el ORIGEN no declara.
 *
 * Access no siempre trae PK. El espejo entonces cae en el surrogate `UNIQUE(_row_hash)` con
 * `DO NOTHING`, que es correcto para movimientos INMUTABLES… y está MAL para una tabla que MUTA:
 * al cambiar cualquier columna cambia el hash, el UPSERT inserta una fila NUEVA y la vieja se
 * queda. El espejo acumula las dos versiones del mismo hecho.
 *
 * Lo destapó CG.9 con `Doctos`: su bandera `Corte` se prende DESPUÉS de capturar. Sin esto, cada
 * movimiento capturado y cortado el mismo día entraría dos veces.
 *
 * ⚠️ REGLAS, porque una identidad mal elegida hace daño en las dos direcciones:
 *   · Las columnas tienen que EXISTIR (se valida acá: una columna mal escrita daría una PK que
 *     Postgres rechaza al crear la tabla, o peor, un conflict target que nunca hace match).
 *   · Las columnas NO pueden ser de las que mutan — si lo son, vuelve el mismo bug.
 *   · Y la combinación tiene que ser ÚNICA sobre el corpus REAL, medido, no supuesto: si colapsa
 *     filas, el espejo deja de ser espejo.
 */
function aplicarPkOverride(t, cfg) {
  const ov = (cfg.PK_OVERRIDE || {})[t.table];
  if (!ov || !ov.length) return t;
  const nombres = new Set((t.columns || []).map((c) => c && c.name));
  const faltan = ov.filter((c) => !nombres.has(c));
  if (faltan.length) {
    // Silencio no: una identidad que no se pudo aplicar deja el surrogate puesto y el bug vivo.
    console.warn(`  ⚠️ ${t.table}: PK_OVERRIDE menciona columnas que no existen (${faltan.join(', ')}) `
      + '→ se ignora y queda el surrogate _row_hash. REVISAR: la tabla sigue sin soportar mutación.');
    return t;
  }
  // `_pkDeclarada` avisa al generador de DDL que esta identidad la pusimos nosotros, no la
  // fuente → va como UNIQUE NULLS NOT DISTINCT, no como PRIMARY KEY (ver access-mirror.js).
  return { ...t, pk: ov, _pkDeclarada: true };
}


function parseArgs(argv) {
  const get = (p) => (argv.find((a) => a.startsWith(p)) || '').split('=')[1];
  const only = get('--only=');
  const watch = get('--watch=');
  return {
    DRY: argv.includes('--dry'),
    ONCE: argv.includes('--once'),
    branchArg: get('--branch='),
    ONLY: only ? new Set(only.split(',').map((s) => s.trim())) : null,
    // Carril a procesar: inc = sólo movimientos (watermark, barato → frescura alta) · hash = sólo
    // catálogos (full-scan, caro → cadencia baja) · all = ambos (default). Base del split WR.5.1.
    CARRIL: (get('--carril=') || 'all').toLowerCase(),
    WATCH_MS: watch ? Number(watch) * 60 * 1000 : 0,
  };
}

/**
 * @param {object} cfg
 *   BRANCHES, REPLICA_URL, MDB_BASE, watermarkCol, WM_INVARIANTE, WM_SIN_PK  — de la fuente
 *   stateTable   nombre calificado de la tabla de watermarks (ej. 'ods.wincaja_watermark')
 *   label        título del log (ej. 'WR.3 réplica cruda Wincaja')
 *   hbPrefix     prefijo de la clave de heartbeat (ej. 'wincaja_replica')
 *   hbLabel      etiqueta legible del heartbeat
 *   batchEnv     nombre de la env var de tamaño de lote
 *   mdbBaseEnv   nombre de la env var de la ruta base (para el mensaje de preflight)
 */
function run(cfg, argv = process.argv) {
  const { DRY, ONCE, branchArg, ONLY, CARRIL, WATCH_MS } = parseArgs(argv);
  const BATCH = Number(process.env[cfg.batchEnv]) || 500;
  const [stSchema, stTable] = String(cfg.stateTable).split('.');
  const schemaCache = new Map();

  async function ensureState(c) {
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${q(stSchema)}`);
    await c.query(`CREATE TABLE IF NOT EXISTS ${q(stSchema)}.${q(stTable)} (
      schema_name text, table_name text, wm_col text,
      wm_value text, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (schema_name, table_name))`);
  }
  async function getWatermark(c, schema, table) {
    const r = await c.query(`SELECT wm_value FROM ${q(stSchema)}.${q(stTable)} WHERE schema_name=$1 AND table_name=$2`, [schema, table]);
    return r.rowCount ? r.rows[0].wm_value : null;
  }
  async function setWatermark(c, schema, table, col, value) {
    await c.query(`INSERT INTO ${q(stSchema)}.${q(stTable)} (schema_name, table_name, wm_col, wm_value, updated_at)
      VALUES ($1,$2,$3,$4, now())
      ON CONFLICT (schema_name, table_name) DO UPDATE SET wm_col=excluded.wm_col, wm_value=excluded.wm_value, updated_at=now()`,
      [schema, table, col, String(value)]);
  }

  /** Descubre (y cachea) el esquema de una sucursal, uniendo sus archivos (.mdb base + MOV). */
  function branchSchema(b) {
    if (schemaCache.has(b.code)) return schemaCache.get(b.code);
    const files = [b.mdb, b.mov].filter(Boolean);
    const seen = new Map();
    const fallas = [];
    for (const f of files) {
      let sc;
      try { sc = A.discoverSchema(f, { noCounts: true }); }
      catch (e) { fallas.push(`${path.basename(f)}: ${e.message}`); continue; }
      for (const t of sc) if (t.columns.length && !seen.has(t.table)) seen.set(t.table, { ...aplicarPkOverride(t, cfg), _file: f });
    }
    const arr = [...seen.values()];
    // Un descubrimiento VACÍO no es un estado válido: es la fuente inalcanzable (share sin montar,
    // .mdb movido). Cachearlo dejó los dos carriles girando en "0 tablas" del 27 al 31 de agosto de
    // 2026 sin recuperarse solos al volver la red. Se tira y NO se cachea → el próximo ciclo reintenta.
    if (!arr.length) {
      throw new Error(`esquema vacío para ${b.code}/${b.schema} — fuente inalcanzable`
        + (fallas.length ? `: ${fallas.join(' · ')}` : ` (revisar ${files.join(', ')})`));
    }
    schemaCache.set(b.code, arr);
    return arr;
  }

  /** Construye el SQL de UPSERT para una tabla (según su conflict target). */
  function buildUpsert(schema, table, cols, conflict) {
    const insertCols = [...cols, HK_HASH];
    const surrogate = conflict.length === 1 && conflict[0] === HK_HASH;
    const colList = insertCols.map(q).join(', ');
    const ph = (rowIdx) => '(' + insertCols.map((_, j) => `$${rowIdx * insertCols.length + j + 1}`).join(', ') + ')';
    const conflictList = conflict.map(q).join(', ');
    let tail;
    if (surrogate) {
      tail = `ON CONFLICT (${conflictList}) DO NOTHING`;
    } else {
      const setList = [...cols.map((cName) => `${q(cName)}=excluded.${q(cName)}`), `${q(HK_HASH)}=excluded.${q(HK_HASH)}`, '_synced_at=now()'].join(', ');
      tail = `ON CONFLICT (${conflictList}) DO UPDATE SET ${setList} WHERE ${q(schema)}.${q(table)}.${q(HK_HASH)} IS DISTINCT FROM excluded.${q(HK_HASH)}`;
    }
    return { head: `INSERT INTO ${q(schema)}.${q(table)} (${colList}) VALUES `, tail, insertCols, ph };
  }

  /** UPSERT en lotes. Devuelve filas afectadas (rowCount acumulado). */
  async function upsertRows(c, schema, table, cols, conflict, rows) {
    if (!rows.length) return 0;
    const { head, tail, ph } = buildUpsert(schema, table, cols, conflict);
    let affected = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values = [];
      const params = [];
      slice.forEach((row, r) => {
        values.push(ph(r));
        for (const cName of cols) { let v = row[cName]; if (v === undefined) v = null; params.push(v); }
        params.push(A.rowHash(pick(row, cols)));
      });
      const res = await c.query(head + values.join(', ') + ' ' + tail, params);
      affected += res.rowCount || 0;
    }
    return affected;
  }

  function pick(row, cols) { const o = {}; for (const c of cols) o[c] = row[c] === undefined ? null : row[c]; return o; }
  function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  /**
   * `[WR.7]` El carril incremental sólo es legítimo si su columna de watermark es TODA la identidad
   * de la tabla. Con una PK de dos ejes —`Cortes`/`Retiros` tienen `(Folio, Caja)` y el folio
   * reinicia por caja— la marca escalar no se "atrasa": deja permanentemente ciegas a las cajas cuyo
   * folio quede por debajo del máximo global. Medido: 5 de 6 cajas y 2,939 de 4,193 retiros de la 30.
   *
   * Ante la duda se cae a hash-delta, que es el carril COMPLETO (full-scan): puede costar tiempo,
   * nunca datos. Y avisa una vez por tabla, porque una degradación muda se lee como que todo va bien.
   */
  const wmAvisado = new Set();
  function watermarkSeguro(t) {
    const col = cfg.watermarkCol(t.table);
    if (!col) return null;
    const pk = (t.pk || []).filter(Boolean);
    if (pk.length > 1) {
      if (!wmAvisado.has(t.table)) {
        wmAvisado.add(t.table);
        console.warn(`  ⚠️ ${t.table}: watermark '${col}' pero la PK es (${pk.join(', ')}) → `
          + `${cfg.WM_INVARIANTE}. Se usa hash-delta (completo) en vez de incremental (ciego).`);
      }
      return null;
    }
    if (pk.length === 1 && pk[0].toLowerCase() !== col.toLowerCase()) {
      if (!wmAvisado.has(t.table)) {
        wmAvisado.add(t.table);
        console.warn(`  ⚠️ ${t.table}: watermark '${col}' no es la PK ('${pk[0]}') → hash-delta.`);
      }
      return null;
    }
    if (pk.length === 0 && !(cfg.WM_SIN_PK || {})[t.table] && !wmAvisado.has(t.table)) {
      wmAvisado.add(t.table);
      console.warn(`  ⚠️ ${t.table}: incremental sin PK y sin motivo declarado en WM_SIN_PK → `
        + 'no se puede probar que la columna sea monótona global. Se usa hash-delta.');
      return null;
    }
    return col;
  }

  /** Sincroniza una tabla (elige carril). Devuelve {carril, read, wrote}. */
  async function syncTable(c, b, t) {
    const cols = dataColumns(t);
    const conflict = conflictTarget(t);
    const wmCol = watermarkSeguro(t);
    const file = t._file || b.mdb;
    if (wmCol) {
      // INCREMENTAL
      const wm = await getWatermark(c, b.schema, t.table);
      const rows = A.readIncremental(file, t.table, { sinceCol: wmCol, sinceVal: wm == null ? 0 : toNum(wm) });
      if (DRY) return { carril: `inc(${wmCol}>${wm ?? 0})`, read: rows.length, wrote: 0 };
      const wrote = await upsertRows(c, b.schema, t.table, cols, conflict, rows);
      if (rows.length) {
        const maxWm = rows.reduce((m, r) => Math.max(m, toNum(r[wmCol])), wm == null ? 0 : toNum(wm));
        await setWatermark(c, b.schema, t.table, wmCol, maxWm);
      }
      return { carril: `inc(${wmCol})`, read: rows.length, wrote };
    }
    // HASH-DELTA (full-scan)
    const rows = A.readTable(file, t.table);
    if (DRY) return { carril: 'hash', read: rows.length, wrote: 0 };
    const wrote = await upsertRows(c, b.schema, t.table, cols, conflict, rows);
    return { carril: 'hash', read: rows.length, wrote };
  }

  async function syncBranch(c, b) {
    const tables = branchSchema(b)
      .filter((t) => !ONLY || ONLY.has(t.table))
      // El split usa `watermarkSeguro`, no `watermarkCol`: una tabla degradada a hash-delta por el
      // invariante tiene que caer en el carril HASH (cadencia baja), no en el rápido haciendo
      // full-scan cada 2 minutos.
      .filter((t) => CARRIL === 'all' || (CARRIL === 'inc' ? !!watermarkSeguro(t) : !watermarkSeguro(t)));
    console.log(`\n=== ${b.code} ${b.name} → ${b.schema} (${tables.length} tablas${ONLY ? ' [filtro]' : ''}${CARRIL !== 'all' ? ' carril=' + CARRIL : ''}) ===`);
    const t0 = Date.now();
    let totRead = 0, totWrote = 0, incN = 0, hashN = 0;
    for (const t of tables) {
      try {
        const r = await syncTable(c, b, t);
        totRead += r.read; totWrote += r.wrote;
        if (r.carril.startsWith('inc')) incN++; else hashN++;
        if (r.read || r.wrote) console.log(`  ${t.table.padEnd(28)} ${r.carril.padEnd(16)} read=${String(r.read).padStart(7)} wrote=${String(r.wrote).padStart(7)}`);
      } catch (e) { console.warn(`  ⚠️ ${t.table}: ${e.message}`); }
    }
    console.log(`  → ${incN} inc / ${hashN} hash · read ${totRead} · wrote ${totWrote} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { totRead, totWrote };
  }

  /**
   * La fuente tiene que existir ANTES de abrir conexiones. Se revisa en CADA ciclo (no una sola vez
   * al arrancar) para que el proceso se cure solo cuando el share vuelve, sin reiniciar PM2.
   */
  function preflightSource() {
    if (require('fs').existsSync(cfg.MDB_BASE)) return;
    const drive = /^([A-Za-z]):/.exec(cfg.MDB_BASE);
    if (drive) {
      console.error(`  "${drive[1]}:" es una unidad MAPEADA, y los mapeos de Windows son POR SESIÓN`);
      console.error('  de login: un servicio o una tarea como SYSTEM puede no verla nunca. Preferí una');
      console.error('  ruta UNC (\\\\servidor\\share\\...) — no depende de la sesión.');
    }
    throw new Error(`${cfg.mdbBaseEnv} inalcanzable: ${cfg.MDB_BASE}`);
  }

  async function cycle() {
    const list = branchArg ? cfg.BRANCHES.filter((b) => b.code === branchArg) : cfg.BRANCHES;
    preflightSource();
    const c = new Client({ connectionString: cfg.REPLICA_URL, statement_timeout: 120000 });
    await c.connect();
    const fallas = [];
    try {
      if (!DRY) await ensureState(c);
      // Una sucursal caída NO debe tapar a las otras: se registra y se sigue con las que sí responden.
      for (const b of list) {
        if (!b.mdb) continue;
        try { await syncBranch(c, b); }
        catch (e) { fallas.push(`${b.code}: ${e.message}`); console.error(`  ✖ ${b.code} ${b.name}: ${e.message}`); }
      }
    } finally { await c.end(); }
    if (fallas.length) throw new Error(`${fallas.length}/${list.length} sucursales fallaron — ${fallas.join(' · ')}`);
  }

  return (async () => {
    const mode = DRY ? 'DRY' : WATCH_MS ? `WATCH ${WATCH_MS / 60000}min` : ONCE ? 'ONCE' : 'ONCE (default)';
    console.log(`=== ${cfg.label} (${mode}) · batch ${BATCH} ===`);
    // El vigilante no puede fallar en silencio: sin destino para el heartbeat, un feed muerto es
    // indistinguible de uno sano — PM2 sigue diciendo "online". Pasó del 27 al 31 de agosto de 2026:
    // 4 días en cero con los dos carriles "online" y el heartbeat abortando por falta de esta var.
    // En watch (desatendido) se aborta el arranque antes que correr a ciegas.
    if (WATCH_MS && !DRY && !process.env.DATABASE_URL_NEW && !process.env.DATABASE_URL) {
      console.error('✖ falta DATABASE_URL_NEW/DATABASE_URL: el heartbeat no podría reportar a cron_runs.');
      console.error('  Exportala antes de "pm2 start" — el ecosystem la pasa explícita. Abortando.');
      process.exit(1);
    }
    // Heartbeat SOLO en modo watch (proceso largo bajo PM2, reemplaza el wrapper PS1/Task Scheduler).
    // Keyed por carril → FeedGuardian/db-health ve cada carril con su propio umbral.
    const hb = (WATCH_MS && !DRY) ? require(path.join(__dirname, 'cron-heartbeat')) : null;
    const HB_KEY = `${cfg.hbPrefix}_${CARRIL}`;
    const runCycle = async () => {
      if (hb) await hb.begin(HB_KEY, `${cfg.hbLabel} (${CARRIL})`).catch(() => {});
      try {
        await cycle();
        if (hb) await hb.end(HB_KEY, { status: 'ok' }).catch(() => {});
      } catch (e) {
        if (hb) await hb.end(HB_KEY, { status: 'error', error: e.message }).catch(() => {});
        throw e;
      }
    };
    // En watch, un primer ciclo fallido NO debe matar el proceso: PM2 quemaría sus max_restarts en
    // minutos y quedaría "errored". Se reporta (el heartbeat ya registró el error) y se entra al loop,
    // que reintenta — y como el esquema vacío ya no se cachea, se cura solo cuando la fuente vuelve.
    try { await runCycle(); }
    catch (e) {
      if (!WATCH_MS || DRY) throw e;
      console.error('primer ciclo falló:', e.message);
    }
    if (WATCH_MS && !DRY) {
      console.log(`\n(loop cada ${WATCH_MS / 60000} min — Ctrl+C para salir)`);
      setInterval(() => { runCycle().catch((e) => console.error('ciclo falló:', e.message)); }, WATCH_MS);
    } else {
      console.log('\nlisto.');
    }
  })().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}

module.exports = { run, parseArgs };
