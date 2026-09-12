/* eslint-disable no-console */
/**
 * CDC.7 — RED DE SEGURIDAD del CDC: reconcilia la VENTANA RECIENTE de las tablas de movimiento
 * entre cada replica local (:5433/kepler_md_XX) y `kepler_ods` en prod, y **repone lo que falte**.
 *
 * POR QUÉ EXISTE
 * --------------
 * El CDC por WAL (`ods-cdc-wal.js`, ADR-047) reemplazó al poll (`replicate-ods-live.js`) y con él se
 * fue la única cosa que sanaba huecos: la ventana de re-envío por fecha de negocio (`ODS_SAFETY_DAYS`).
 * Un stream de WAL no tiene reintento posible hacia atrás: si el slot muere y se recrea —lo que pasa
 * cuando `wal_status` llega a `lost` por el cap `max_slot_wal_keep_size`— todo lo ocurrido en ese
 * hueco **no vuelve nunca**. Y no hay señal: los sensores miden frescura (`max(fecha)`), así que un
 * agujero en el medio con datos frescos alrededor es invisible.
 *
 * Lo vivimos el 2026-08-31: 285 renglones de `kdm2` en 74 documentos, con la cabecera presente y el
 * detalle ausente. La pantalla lo mostraba como "su único renglón es de servicio" (una factura de
 * $4,518 con 3 renglones reales) y lo detectó un humano, no un sensor.
 *
 * QUÉ HACE
 * --------
 * Por sucursal × tabla: compara el conjunto de LLAVES PRIMARIAS de la ventana reciente (local vs ODS
 * de prod), lee del replica sólo las filas ausentes y las shipea por `raw-upsert` (idempotente, mismo
 * camino que el CDC). No borra nada, no toca el CDC, no lee el POS. Ship = sólo el delta real.
 *
 * Desde OBS.8 mira el espejo COMPLETO, no sólo la mitad: además de los FALTANTES (que repone) cuenta
 * los SOBRANTES — llaves que siguen en el ODS y ya no están en el replica. Al retirarse el CDC WAL se
 * fue lo único que propagaba DELETE, y este es su reemplazo.
 *
 * OBS.11 (Opción A, 2026-09-12): con `--delete-sobrantes` (o `ODS_DELETE_SOBRANTES=1`) ya no sólo
 * reporta — PROPAGA el DELETE al ODS por `raw-delete` (el MISMO camino que usaba el WAL-CDC retirado).
 * Dos frenos anti-catástrofe: (1) re-confirma cada sobrante contra la tabla COMPLETA del replica —un
 * sobrante que sigue ahí salió de la ventana por cambio de fecha, NO fue borrado → no se toca; 0% falso
 * positivo medido 2026-09-12—; (2) nunca borra más de `ODS_DELETE_MAX_FRAC` (default 0.6) del ODS de una
 * tabla×rama en una pasada: una réplica rota haría parecer sobrante a TODO el ODS, así que si se pasa,
 * ABORTA y reporta. `--full` ignora la ventana para el barrido único del backlog (sólo-DELETE, no
 * repone). Su alarma de sobrantes-como-señal nace APAGADA (`ODS_SOBRANTES_ALERT=0`); el DELETE, OFF.
 *
 * La ventana se acota por la FECHA DE NEGOCIO de cada tabla (`RECENT_COL`), no por `c9` en todas:
 * `c9` es fecha sólo en `kdm1`; en `kdm2` es CANTIDAD. Misma tabla de columnas que usaba la red de
 * seguridad vieja, ya verificada (kdm2.c32 ≡ fecha del header en 99.999% de las filas).
 *
 * Uso:
 *   node reconcile-ods-window.js                       # dry-run, 3 días, todas las sucursales
 *   node reconcile-ods-window.js --days=10 --apply     # repone
 *   node reconcile-ods-window.js --branch=06 --tables=kdm2 --days=15 --apply
 *   node reconcile-ods-window.js --apply --watch=900   # continuo cada 15 min (bajo PM2)
 *
 * Env: ODS_SOURCE_BASE (base :5433) · DATABASE_URL_NEW (destino prod, sólo para LEER las llaves)
 *      FEEDS_SINK=http + FEEDS_INGEST_URL + FEEDS_INGEST_KEY (el ship, igual que el CDC)
 */

const { Client } = require('pg');
const sink = require('../lib/sink');
const { asegurar: asegurarTablasCalendario } = require('./ensure-monthly-tables');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const DAYS = Math.max(1, Number(arg('days', 3)));
const ONLY_BRANCH = arg('branch', null);
const TABLES = String(arg('tables', 'kdm1,kdm2,kdij,kdue,kdpord')).split(',').map((s) => s.trim()).filter(Boolean);
const WATCH_ARG = process.argv.find((a) => a === '--watch' || a.startsWith('--watch='));
const WATCH_SEC = WATCH_ARG ? Math.max(60, Number(WATCH_ARG.split('=')[1] || 900)) : 0;
const SHIP_BATCH = Math.max(200, Number(process.env.ODS_SHIP_BATCH) || 2000);

// OBS.11 — propagación de DELETE (Opción A, 2026-09-12). El reconciliador ya detectaba los SOBRANTES
// con 0% falso positivo; ahora, con gate, los BORRA. Reemplaza al WAL-CDC retirado (OBS.8, fragilidad
// de slot) como propagador de DELETE. OFF por default: sólo con --delete-sobrantes o env=1.
const DELETE_SOB = process.argv.includes('--delete-sobrantes') || process.env.ODS_DELETE_SOBRANTES === '1';
const FULL = process.argv.includes('--full'); // ignora la ventana: barrido único del backlog (solo-DELETE)
// Freno anti-catástrofe: si una réplica se rompe y devuelve pocas/0 filas, TODO el ODS parece sobrante.
// Nunca borrar más de esta fracción del ODS de una tabla×rama en una pasada; si se pasa, ABORTA y reporta.
const MAX_DELETE_FRAC = Math.min(1, Math.max(0.05, Number(process.env.ODS_DELETE_MAX_FRAC) || 0.6));

// Ventana por tabla: fecha de NEGOCIO, y en kdm1 también la de CAPTURA (`c68`). Vive en
// ../lib/ods-recent-window.js, compartida con la red de seguridad de replicate-ods-live.js.
// 2026-09-09: con sólo `c9` este reconciliador NO veía los pagos capturados con fecha valor atrasada
// >3 días que el ctid saltó — en prod faltaban 17 X-D-26 de Oficinas y acá daba `faltan: 0`.
// Una tabla sin ventana se salta (reconciliar una tabla entera por PK sería carísimo).
const { RECENT_COL, recentWindowSql } = require('../lib/ods-recent-window');

const SUB_BASE = process.env.ODS_SOURCE_BASE
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
// 2026-09-07: la 03 dejó de ser la excepción (`kepler_pilot` → `kepler_md_03`). Las 7 ramas
// siguen la misma convención; ver la nota en `replicate-ods-live.js`.
const { replicaDbName: localDbName } = require('../lib/kepler-branches'); // convención única de nombre de réplica
const localUrl = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return u.toString(); };
const BRANCH_CODES = (ONLY_BRANCH ? [ONLY_BRANCH] : (process.env.ODS_LIVE_BRANCHES || '00,01,02,03,04,05,06').split(','))
  .map((s) => s.trim()).filter(Boolean);

const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const mapType = (dt) => ({
  numeric: 'numeric', 'double precision': 'double precision', real: 'real', integer: 'integer',
  bigint: 'bigint', smallint: 'smallint', boolean: 'boolean', date: 'date',
  'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
}[dt] || 'text');

/** Columnas + PK de md.<table> en el replica. */
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

const keyOf = (pk, row) => pk.map((k) => String(row[k] ?? '\x00')).join('|');

/** ¿Cuáles de estas llaves SIGUEN existiendo en md.<table> (tabla COMPLETA, sin ventana)? El re-chequeo
 * que separa un DELETE real (ausente de la tabla) de un artefacto de ventana (salió de la ventana por
 * cambio de fecha, pero la fila sigue viva). Sin esto, borrar por "no está en la ventana" borraría vivos. */
async function existsInReplicaFull(local, table, pk, rows) {
  const found = new Set();
  const pkList = pk.map(qid).join(', ');
  const B = 800;
  for (let i = 0; i < rows.length; i += B) {
    const chunk = rows.slice(i, i + B);
    const binds = chunk.flatMap((r) => pk.map((k) => r[k]));
    const ph = chunk.map((_, ix) => `(${pk.map((__, j) => `$${ix * pk.length + j + 1}`).join(',')})`).join(',');
    const res = await local.query(`SELECT ${pkList} FROM md.${qid(table)} WHERE (${pkList}) IN (${ph})`, binds);
    for (const r of res.rows) found.add(keyOf(pk, r));
  }
  return found;
}

async function reconcile(local, prod, code, table) {
  if (!RECENT_COL[table] && !FULL) return { suc: code, tabla: table, skip: 'sin columna de fecha de negocio' };
  const meta = await tableMeta(local, table);
  if (!meta) return { suc: code, tabla: table, skip: 'no existe en el replica' };
  if (!meta.pk.length) return { suc: code, tabla: table, skip: 'sin PK' };

  const pkList = meta.pk.map(qid).join(', ');
  // Misma ventana en los DOS lados (replica y ODS comparten columnas): kdm1 = c9 OR c68.
  // --full la ignora (barrido de backlog): compara la tabla COMPLETA, sólo para borrar (no repone).
  const ventana = FULL ? 'TRUE' : recentWindowSql(table, meta.cols, DAYS);
  if (!ventana) return { suc: code, tabla: table, skip: 'columna de fecha no es date/timestamp en el replica' };
  const wLoc = FULL ? '' : `WHERE ${ventana}`;
  const wOds = FULL ? '' : `AND ${ventana}`;

  const loc = (await local.query(`SELECT ${pkList} FROM md.${qid(table)} ${wLoc}`)).rows;
  // Freno #1: una réplica que devuelve 0 filas en el scope NO prueba "todo se borró en origen" —
  // prueba réplica rota/vacía. Con el ODS lleno, borrar por esto lo vaciaría. Nunca se borra así.
  if (!loc.length) return { suc: code, tabla: table, local: 0, faltan: 0, ...(DELETE_SOB ? { skip_delete: 'replica 0 filas en scope — NO se borra (posible replica rota)' } : {}) };

  // El ODS es multi-sucursal: SIEMPRE filtrar por `sucursal`, o se compara contra las 7 ramas.
  const pro = (await prod.query(
    `SELECT ${pkList} FROM kepler_ods.${qid(table)} WHERE btrim(sucursal)=$1 ${wOds}`, [code])).rows;
  const presentes = new Set(pro.map((r) => keyOf(meta.pk, r)));
  const locales = new Set(loc.map((r) => keyOf(meta.pk, r)));
  const faltan = FULL ? [] : loc.filter((r) => !presentes.has(keyOf(meta.pk, r))); // --full no repone (sería re-ship masivo)
  const sobran = pro.filter((r) => !locales.has(keyOf(meta.pk, r)));
  const extra = sobran.length
    ? { sobrantes: sobran.length, ej_sobrantes: sobran.slice(0, 3).map((r) => keyOf(meta.pk, r)).join(' ') }
    : {};

  // ── PROPAGACIÓN DE DELETE (OBS.11, gated) — reemplaza al WAL-CDC como propagador de DELETE ──
  // En modo ventana re-confirma cada sobrante contra la tabla COMPLETA del replica: uno que sigue ahí
  // salió de la ventana por fecha (NO borrado) → no se toca. En --full, `sobran` YA es la comparación
  // completa. Freno #2: nunca borrar más de MAX_DELETE_FRAC del ODS de esa tabla×rama en una pasada.
  if (DELETE_SOB && sobran.length) {
    const confirmadas = FULL
      ? sobran
      : await (async () => {
        const found = await existsInReplicaFull(local, table, meta.pk, sobran);
        return sobran.filter((r) => !found.has(keyOf(meta.pk, r)));
      })();
    extra.confirmadas_borrar = confirmadas.length;
    if (confirmadas.length > MAX_DELETE_FRAC * Math.max(pro.length, 1)) {
      extra.delete_abortado = `${confirmadas.length}/${pro.length} (${(100 * confirmadas.length / Math.max(pro.length, 1)).toFixed(0)}%) > ${(100 * MAX_DELETE_FRAC).toFixed(0)}% — ABORTADO, revisar a mano`;
    } else if (APPLY && confirmadas.length) {
      const delMeta = { table, pk: meta.pk, columns: [{ name: 'sucursal', type: 'text' }, ...meta.cols.map((c) => ({ name: c.column_name, type: mapType(c.data_type) }))] };
      let borrados = 0;
      for (let i = 0; i < confirmadas.length; i += SHIP_BATCH) {
        const chunk = confirmadas.slice(i, i + SHIP_BATCH).map((r) => { const o = { sucursal: code }; for (const k of meta.pk) o[k] = r[k]; return o; });
        await sink.ship('raw-delete', { rows: chunk, tenantId: TENANT, meta: delMeta });
        borrados += chunk.length;
      }
      extra.borrados = borrados;
    } else if (confirmadas.length) {
      extra.borrarian = confirmadas.length; // dry-run
    }
  }

  if (!faltan.length) return { suc: code, tabla: table, local: loc.length, faltan: 0, ...extra };
  if (!APPLY) return { suc: code, tabla: table, local: loc.length, faltan: faltan.length, dry: true, ...extra };

  // Releer las filas COMPLETAS de las llaves ausentes y shipearlas por el camino del CDC.
  const selList = meta.cols.map((c) => qid(c.column_name)).join(', ');
  const shipMeta = { table, pk: meta.pk, columns: [{ name: 'sucursal', type: 'text' }, ...meta.cols.map((c) => ({ name: c.column_name, type: mapType(c.data_type) }))] };
  let enviadas = 0;
  for (let i = 0; i < faltan.length; i += SHIP_BATCH) {
    const chunk = faltan.slice(i, i + SHIP_BATCH);
    const binds = chunk.flatMap((r) => meta.pk.map((k) => r[k]));
    const ph = `(${pkList}) IN (${chunk.map((_, ix) => `(${meta.pk.map((__, j) => `$${ix * meta.pk.length + j + 1}`).join(',')})`).join(',')})`;
    const full = (await local.query(`SELECT ${selList} FROM md.${qid(table)} WHERE ${ph}`, binds)).rows;
    const rows = full.map((row) => { const o = { sucursal: code }; for (const c of meta.cols) o[c.column_name] = row[c.column_name]; return o; });
    if (rows.length) { await sink.ship('raw-upsert', { rows, tenantId: TENANT, meta: shipMeta }); enviadas += rows.length; }
  }
  return { suc: code, tabla: table, local: loc.length, faltan: faltan.length, enviadas, ...extra };
}

/** Una pasada completa. Devuelve el detalle por (sucursal, tabla). */
async function pasada(destUrl) {
  const prod = new Client({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, statement_timeout: 600000 });
  await prod.connect();
  const out = [];
  try {
    for (const code of BRANCH_CODES) {
      const local = new Client({ connectionString: localUrl(code), statement_timeout: 600000 });
      try { await local.connect(); } catch (e) { out.push({ suc: code, skip: `replica no conecta: ${e.message.slice(0, 40)}` }); continue; }
      for (const t of TABLES) {
        // Una tabla que falla NO corta la pasada: la siguiente sucursal todavía puede sanarse.
        try { out.push(await reconcile(local, prod, code, t)); }
        catch (e) { out.push({ suc: code, tabla: t, error: e.message.slice(0, 80) }); }
      }
      await local.end().catch(() => {});
    }
  } finally { await prod.end().catch(() => {}); }
  return out;
}

const resumen = (out) => ({
  huecos: out.reduce((a, r) => a + (r.faltan || 0), 0),
  repuestas: out.reduce((a, r) => a + (r.enviadas || 0), 0),
  sobrantes: out.reduce((a, r) => a + (r.sobrantes || 0), 0),
  borrados: out.reduce((a, r) => a + (r.borrados || 0), 0),
  borrarian: out.reduce((a, r) => a + (r.borrarian || 0), 0),
  abortados: out.filter((r) => r.delete_abortado).length,
  errores: out.filter((r) => r.error).length,
});

// Umbral de alarma. Cada pasada lee el replica y DESPUÉS prod: lo que se creó en ese intervalo se ve
// "ausente" sin serlo. Un puñado por pasada es ese ruido; decenas son pérdida real.
const ALERTA = Math.max(1, Number(process.env.ODS_RECONCILE_ALERT) || 50);

// Umbral de SOBRANTES, aparte y APAGADO por default (0 = sólo reportar en la nota, nunca poner rojo).
// Deliberado: todavía no está medido cuánto de este número es DELETE sin propagar y cuánto es la fila
// que se salió de la ventana por cambio de fecha de negocio. Encender una alarma con un piso
// desconocido fabrica un rojo permanente, y un rojo permanente que nadie atiende enseña a ignorar el
// tablero — es justo lo que acabábamos de limpiar. Se sube a un número real cuando haya semanas de
// observación, poniendo ODS_SOBRANTES_ALERT en ops/ingest/docker-compose.yml.
const ALERTA_SOBRANTES = Math.max(0, Number(process.env.ODS_SOBRANTES_ALERT) || 0);

/**
 * Latido al MISMO tablero que mira Administración (`analytics.cron_runs` → db-health).
 *
 * Se escribe DIRECTO a prod, no por el feed `cdc-heartbeat`, por dos razones: acá ya hay conexión a
 * prod (se usa para leer las llaves), y sobre todo porque un latido no debe viajar por el mismo canal
 * que vigila. Cuando feeds-ingest se cae, el ship Y el latido fallan juntos y el dead-man's switch
 * queda mudo justo cuando hace falta — ya pasó el 26/08 con la key rotada (401 en los 7 consumidores,
 * sin alarma) y otra vez hoy 00:05-00:07 (404 `Application not found`). Ver ecosystem.cdc.config.js.
 *
 * `status='error'` → db-health lo marca CRÍTICO sin importar la antigüedad. Es la única alarma del
 * sistema que mide COMPLETITUD. Ojo con la diferencia, que es el corazón del bug de CDC.7: los
 * latidos de `cdc_wal_00..06` estuvieron **verdes y correctos** todo el tiempo mientras se perdía
 * 2-7% de las filas diarias. Un latido prueba que el caño se mueve, no que llegó todo.
 */
async function latir(destUrl, r, ms) {
  const c = new Client({ connectionString: destUrl, ssl: { rejectUnauthorized: false }, statement_timeout: 30000 });
  try {
    await c.connect();
    const sobranMal = ALERTA_SOBRANTES > 0 && r.sobrantes > ALERTA_SOBRANTES;
    const malo = r.huecos > ALERTA || r.errores > 0 || sobranMal || r.abortados > 0;
    await c.query(`
      INSERT INTO analytics.cron_runs
        (tenant_id, job_key, label, last_start, last_finish, status, rows_affected, duration_ms, note, error, host, updated_at)
      VALUES ($1,'cdc_reconcile','Reconciliador ODS (completitud)', now() - ($2::int || ' ms')::interval, now(),
              $3, $4, $2, $5, $6, $7, now())
      ON CONFLICT (tenant_id, job_key) DO UPDATE SET
        last_start=EXCLUDED.last_start, last_finish=EXCLUDED.last_finish, status=EXCLUDED.status,
        rows_affected=EXCLUDED.rows_affected, duration_ms=EXCLUDED.duration_ms,
        note=EXCLUDED.note, error=EXCLUDED.error, host=EXCLUDED.host, updated_at=now()`,
    [TENANT, ms, malo ? 'error' : 'ok', r.repuestas,
      `ventana ${FULL ? 'FULL' : DAYS + 'd'} · huecos ${r.huecos} · repuestas ${r.repuestas} · sobrantes ${r.sobrantes}${DELETE_SOB ? ` · borrados ${r.borrados}` : ''}${r.abortados ? ` · ABORTADOS ${r.abortados}` : ''} · errores ${r.errores}`,
      malo ? [
        r.huecos > ALERTA ? `${r.huecos} filas ausentes en el ODS (umbral ${ALERTA}) — el carril esta perdiendo filas` : null,
        sobranMal ? `${r.sobrantes} filas de mas en el ODS (umbral ${ALERTA_SOBRANTES}) — DELETE sin propagar, revisar a mano` : null,
        r.errores > 0 ? `${r.errores} tablas con error` : null,
        r.abortados > 0 ? `${r.abortados} tablas con DELETE abortado (fraccion > ${(100 * MAX_DELETE_FRAC).toFixed(0)}%) — revisar a mano` : null,
      ].filter(Boolean).join(' · ') : null,
      require('os').hostname()]);
  } catch (e) {
    console.error(`latido falló: ${e.message}`);   // nunca corta la reconciliación
  } finally { await c.end().catch(() => {}); }
}

(async () => {
  const destUrl = process.env.DATABASE_URL_NEW;
  if (!destUrl) { console.error('Falta DATABASE_URL_NEW (se lee para comparar las llaves del ODS).'); process.exit(2); }
  console.log(`reconcile-ods-window · ${FULL ? 'FULL (backlog)' : `ventana ${DAYS}d`} · tablas ${TABLES.join(',')} · ${APPLY ? 'APPLY' : 'dry-run'}${DELETE_SOB ? ' · DELETE-SOBRANTES' : ''}${WATCH_SEC ? ` · watch ${WATCH_SEC}s` : ''}\n`);

  if (!WATCH_SEC) {
    const out = await pasada(destUrl);
    console.table(out);
    const r = resumen(out);
    console.log(`\nfilas ausentes en el ODS: ${r.huecos}${APPLY ? ` · repuestas: ${r.repuestas}` : ' (dry-run: nada se envió)'}`);
    console.log(`filas de MÁS en el ODS: ${r.sobrantes}${DELETE_SOB
      ? (APPLY ? ` · BORRADAS: ${r.borrados}` : ` · borrarían: ${r.borrarian}`) + (r.abortados ? ` · ABORTADOS: ${r.abortados} (fracción > ${(100 * MAX_DELETE_FRAC).toFixed(0)}%)` : '')
      : ' — sólo se reportan (usá --delete-sobrantes para propagar el DELETE)'}`);
    process.exit(0);
  }

  // Modo continuo (PM2). Una pasada limpia imprime UNA línea; un hueco imprime el detalle, porque
  // con el CDC sano esto debe ser 0 siempre: cualquier número > 0 es la firma de que algo se está
  // perdiendo otra vez, y se quiere ver dónde sin tener que reproducirlo.
  for (;;) {
    const t0 = Date.now();
    try {
      // CDC.8 — antes de reconciliar, asegurar las tablas de calendario. Si a Kepler le nace la
      // tabla del mes y el replica no la tiene, el apply worker entra en bucle y la rama se
      // congela entera: reponer filas no sirve de nada si la fuente dejó de recibir. Es barato
      // (una consulta a information_schema por familia) e idempotente.
      const tablas = await asegurarTablasCalendario({ apply: true });
      const nuevas = tablas.filter((t) => t.creadas?.length);
      if (nuevas.length) console.log(`[${new Date().toISOString()}] tablas de calendario creadas: ` + nuevas.map((t) => `${t.suc}:${t.creadas.join('/')}`).join(' · '));

      const out = await pasada(destUrl);
      const r = resumen(out);
      if (r.huecos || r.errores) console.table(out.filter((x) => x.faltan || x.error || x.skip));
      console.log(`[${new Date().toISOString()}] huecos ${r.huecos} · repuestas ${r.repuestas} · errores ${r.errores} · ${Math.round((Date.now() - t0) / 1000)}s`);
      await latir(destUrl, r, Date.now() - t0);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] pasada falló: ${e.message}`);
    }
    await new Promise((res) => setTimeout(res, WATCH_SEC * 1000));
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
