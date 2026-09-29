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
// [OBS.12] Dedup de tablas con fecha en la PK. OFF por default, igual que el DELETE: borra.
const DEDUPE = process.argv.includes('--dedupe-fecha') || process.env.ODS_DEDUPE_FECHA === '1';
const FULL = process.argv.includes('--full'); // ignora la ventana: barrido único del backlog (solo-DELETE)

// ⭐ `[ODS.2]` MODO TABLA CHICA: sin ventana, y SÍ repone.
//
// El comentario de abajo decía "reconciliar una tabla entera por PK sería carísimo" y por eso una
// tabla sin fecha de negocio se SALTABA. Medido el 2026-09-23, eso es cierto para `kdm2` (1.8M filas)
// y falso para el resto: de las 17 tablas que estaban perdiendo filas, **14 pesan ≤30 MB** y la
// mayoría menos de 10. Comparar sus llaves completas cuesta milisegundos.
//
// Y sigue siendo "sólo los cambios": se comparan LLAVES, se shipean únicamente las ausentes. Lo que
// no se hace nunca es traer las filas enteras de la tabla.
//
// Se diferencia de `--full`, que ignora la ventana pero NO repone ("sería re-ship masivo" — cierto
// para las grandes). Acá sí repone, porque el universo es chico por construcción.
//
// ⛔ EL FRENO VIVE EN EL CÓDIGO, NO EN QUIEN LO INVOCA. Este modo es válido *porque* las tablas son
// chicas; si alguien lo apunta a `kdm2` deja de serlo. Por eso se mide el tamaño real en el ODS y se
// SALTA lo que pase del tope, en vez de confiar en que la lista de tablas esté bien escrita.
const CHICAS = process.argv.includes('--chicas');
const CHICAS_MAX_MB = Math.max(1, Number(process.env.ODS_CHICAS_MAX_MB) || 100);
/** Sin ventana de fecha: compara el universo completo de llaves. Lo comparten `--full` y `--chicas`. */
const SIN_VENTANA = FULL || CHICAS;

// Freno anti-catástrofe: si una réplica se rompe y devuelve pocas/0 filas, TODO el ODS parece sobrante.
// Nunca borrar más de esta fracción del ODS de una tabla×rama en una pasada; si se pasa, ABORTA y reporta.
const MAX_DELETE_FRAC = Math.min(1, Math.max(0.05, Number(process.env.ODS_DELETE_MAX_FRAC) || 0.6));
// Latido: el carril continuo late como 'cdc_reconcile'; el barrido agendado (ods-reconcile-full)
// setea ODS_RECONCILE_HB_KEY para NO pisar ese latido (un carril = un dueño del renglón de cron_runs).
const HB_KEY = (process.env.ODS_RECONCILE_HB_KEY || 'cdc_reconcile').replace(/[^a-z0-9_]/gi, '') || 'cdc_reconcile';

// ⛔ UN MODO DISTINTO NO PUEDE HEREDAR EL LATIDO DEL CARRIL BASE.
//
// Medido el 2026-09-24: `ods-reconcile-chicas` se levantó con `ODS_HB_KEY` —el nombre que usan
// los OTROS servicios de `ops/vl/docker-compose.yml`— en vez de `ODS_RECONCILE_HB_KEY`, que es el
// que lee este archivo. El default de arriba lo mandó a `'cdc_reconcile'` y estuvo **pisando el
// renglón del reconciliador con ventana**, que este mismo script llama "la única alarma de
// COMPLETITUD". Dos carriles escribiendo la MISMA fila: el tablero mostraba al último que corriera.
//
// ⚠️ Eso es PEOR que un carril mudo. Uno mudo deja un renglón envejeciendo, y envejecer se ve; éste
// mantenía el renglón AJENO fresco y verde con SUS propios números — el modo de falla que no deja
// rastro. Un default silencioso convirtió un nombre de variable mal puesto en datos corruptos.
//
// Con `--full` o `--chicas` la llave se exige EXPLÍCITA. Una corrida a mano (sin `--watch`) no late
// —ya estaba así de antes— y por eso sólo se frena el modo continuo, que es el que escribe.
if ((FULL || CHICAS) && WATCH_SEC && !process.env.ODS_RECONCILE_HB_KEY) {
  console.error(
    `FALLO: el modo ${FULL ? '--full' : '--chicas'} en continuo necesita ODS_RECONCILE_HB_KEY propia.\n`
    + `       Sin ella latiría como '${HB_KEY}' y pisaría el renglón de OTRO carril en cron_runs.\n`
    + `       ⚠️ La variable es ODS_RECONCILE_HB_KEY, no ODS_HB_KEY (ése lo leen los shippers).`);
  process.exit(1);
}

// Ventana por tabla: fecha de NEGOCIO, y en kdm1 también la de CAPTURA (`c68`). Vive en
// ../lib/ods-recent-window.js, compartida con la red de seguridad de replicate-ods-live.js.
// 2026-09-09: con sólo `c9` este reconciliador NO veía los pagos capturados con fecha valor atrasada
// >3 días que el ctid saltó — en prod faltaban 17 X-D-26 de Oficinas y acá daba `faltan: 0`.
// Una tabla sin ventana se salta (reconciliar una tabla entera por PK sería carísimo).
const { RECENT_COL, recentWindowSql } = require('../lib/ods-recent-window');

const SUB_BASE = process.env.ODS_SOURCE_BASE
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
// 2026-09-07: la 03 dejó de ser la excepción (`kepler_pilot` → `kepler_md_03`). Las ramas
// siguen la misma convención; ver la nota en `replicate-ods-live.js`.
const { replicaDbName: localDbName, BRANCHES } = require('../lib/kepler-branches'); // convención única
const localUrl = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return u.toString(); };

// ⛔ [ODS.1] LA LISTA SALE DEL CATÁLOGO CANÓNICO, NO DE UNA CADENA A MANO.
//
// Acá vivía `'00,01,02,03,04,05,06'` — SIETE ramas — mientras el resto del pipeline ya usaba
// las NUEVE. El archivo ya importaba de `kepler-branches`; sólo que para el nombre de la
// réplica, no para la lista. Y el contenedor `ods-reconcile-full` (el ÚNICO que propaga
// DELETE) es justo el que no define `ODS_LIVE_BRANCHES`, así que caía a este default.
//
// Medido en prod el 2026-09-23: el reconciliador nocturno recorría 00→06 y terminaba. Morelia
// Madero (07) y Morelia Abastos (08) NUNCA se reconciliaban. Consecuencia en la 08:
// `kdpord` con 4,603 filas en el ODS contra 1,669 en la réplica — 2,934 borradas en el origen
// que el ODS seguía publicando. Y no había señal: el reporte decía "filas ausentes: 0" porque
// las ramas que no mira no pueden faltarle.
//
// ⚠️ Es la MISMA clase de falla que dejó a Morelia Abastos fuera de `mv_sales_blended`
// ($1.64M invisibles, ver `analytics.v_branch_erp_cutover`): una lista de sucursales escrita a
// mano que no creció con el negocio. Por eso no se corrige el número — se corrige la FUENTE.
const BRANCH_CODES = (ONLY_BRANCH
  ? [ONLY_BRANCH]
  : (process.env.ODS_LIVE_BRANCHES || BRANCHES.map((b) => b.code).join(',')).split(','))
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

// ⛔ `[ODS.2]` ESTA LÍNEA TIENE UN SUPUESTO QUE NO ESTABA ESCRITO: `String(valor)`.
// Sobre un `timestamp`, el driver de pg devuelve un `Date` de JS y `String()` lo renderiza como
// `"Sun Sep 20 2026 06:00:00 GMT-0600 (Central Standard Time)"` — dependiente de la zona del
// proceso y de la representación, no del instante. Sobre un `numeric`, `1.50` y `1.5` son llaves
// distintas. Las cinco tablas originales tienen PK 100% TEXTO, así que funcionó por casualidad.
// Con una PK que traiga timestamp, la MISMA fila cuenta como ausente Y como sobrante — y con
// `--delete-sobrantes` encendido eso BORRA FILAS VIVAS. Por eso `pkComparable()` lo frena abajo.
const keyOf = (pk, row) => pk.map((k) => String(row[k] ?? '\x00')).join('|');

/**
 * `[ODS.2]` LA LLAVE LA ARMA POSTGRES, NO `String()` DE JS.
 *
 * Cada columna de la PK se lleva a una forma CANÓNICA que los dos lados producen igual:
 *   · numeric → `trim_scale()` antes de `::text`. El mismo valor puede venir como `1.50` de un
 *     lado y `1.5` del otro cuando los tipos declarados difieren en escala — y difieren: medido,
 *     `kdfedir.c1` es `numeric` en el ODS y `numeric(1,0)` en el réplica. `trim_scale` los iguala.
 *   · el resto → `::text`, que en Postgres es determinista.
 * `coalesce(...,'\x00')` conserva la semántica del `keyOf` viejo para NULL.
 *
 * ⛔ El timestamp queda FUERA aunque `::text` sea determinista, y no por la comparación sino por
 * los DATOS: el ODS trae los timestamps anteriores al 2026-09-23 corridos 6 h (ver la nota en
 * `lib/ods-recent-window.js`). Compararlos daría "falta y sobra la misma fila" — un molino.
 */
const TIPOS_PK_FECHA = new Set(['timestamp without time zone', 'timestamp with time zone', 'date']);
// Si el origen guarda la columna SIEMPRE a medianoche, el corrimiento de 6 h no cruza el día y el
// DÍA sí es comparable. Pero eso hay que MEDIRLO por tabla, no suponerlo: una columna con hora
// real (captura, no fecha de negocio) rompe el supuesto y ahí el veto sigue valiendo.
// ⚠️ El tope de 12 h no es cosmético: con el origen a medianoche, cualquier corrimiento POSITIVO
// menor a 24 h conserva el día. Lo que rompería el día es uno NEGATIVO, y eso se ve como horas
// altas con el día ya retrocedido. 12 h separa un huso horario de un día corrido.
const SHIFT_MAX_HORAS = 12;

function pkKeyExpr(meta, fechaCols) {
  const tipo = new Map(meta.cols.map((c) => [c.column_name, String(c.data_type || '').toLowerCase()]));
  return meta.pk.map((k) => {
    const t = tipo.get(k);
    // Fecha VERIFICADA como de medianoche → se compara el día, que los dos lados producen igual.
    if (fechaCols && fechaCols.has(k)) return `coalesce(to_char(date_trunc('day', ${qid(k)}), 'YYYY-MM-DD'), chr(1))`;
    const base = t === 'numeric' ? `trim_scale(${qid(k)})::text` : `${qid(k)}::text`;
    return `coalesce(${base}, chr(1))`;
  }).join(` || '|' || `);
}

/**
 * ¿Se puede comparar la PK de esta tabla? Devuelve `{ motivo }` si NO, o `{ fechaCols }` si sí.
 * Es un freno de CORRECCIÓN, no de rendimiento: comparar mal no da error, da un veredicto falso.
 *
 * ⭐ `[OBS.12]` Antes vetaba TODA PK con fecha, y eso dejaba fuera a las tablas contables
 * `kdc2YYMM` — justo donde el residuo entra a la balanza y al P&L. El veto era correcto como
 * default y equivocado como final: el problema no es que haya un timestamp, es que el ODS lo trae
 * corrido. Si el origen lo guarda a medianoche, el día es idéntico de los dos lados.
 * Medido 2026-09-29 en la rama 00: `kdc22608`/`kdc22609` tienen **cero** filas con hora en la
 * réplica, y en el ODS sólo existen las horas `00:00` y `06:00`. Acá se vuelve a medir en cada
 * corrida en vez de confiar en esa medición: una medición con fecha es código que caduca.
 */
async function pkNoComparable(meta, local, prod, table, code) {
  const tipo = new Map(meta.cols.map((c) => [c.column_name, c.data_type]));
  const conFecha = meta.pk.filter((k) => TIPOS_PK_FECHA.has(String(tipo.get(k) || '').toLowerCase()));
  if (!conFecha.length) return { fechaCols: null };

  const fechaCols = new Set();
  for (const k of conFecha) {
    // (a) el ORIGEN tiene que ser semántica de fecha pura.
    const nz = Number((await local.query(
      `SELECT count(*)::bigint n FROM md.${qid(table)} WHERE ${qid(k)} IS NOT NULL AND ${qid(k)}::time <> '00:00:00'`)).rows[0].n);
    if (nz > 0) {
      return { motivo: `PK con fecha ${k}:${tipo.get(k)} y el origen le pone HORA real en ${nz} filas `
        + '— no es semantica de fecha, comparar por dia daria un veredicto falso' };
    }
    // (b) el corrimiento del ODS tiene que ser POSITIVO y chico, o el día ya se movió.
    let hi = null;
    try {
      hi = (await prod.query(
      `SELECT max(${qid(k)}::time)::text h FROM kepler_ods.${qid(table)} WHERE btrim(sucursal)=$1 AND ${qid(k)} IS NOT NULL`,
        [code])).rows[0].h;
    } catch (e) {
      return { motivo: 'PK con fecha ' + k + ': no pude medir el corrimiento en el ODS (' + String(e.message).slice(0, 50) + ')' };
    }
    if (hi && Number(String(hi).slice(0, 2)) >= SHIFT_MAX_HORAS) {
      return { motivo: `PK con fecha ${k}: el ODS llega a ${hi} sobre un origen de medianoche `
        + `(tope ${SHIFT_MAX_HORAS} h) — eso ya no parece huso horario sino dia corrido` };
    }
    fechaCols.add(k);
  }
  return { fechaCols };
}

/** ¿Cuáles de estas llaves SIGUEN existiendo en md.<table> (tabla COMPLETA, sin ventana)? El re-chequeo
 * que separa un DELETE real (ausente de la tabla) de un artefacto de ventana (salió de la ventana por
 * cambio de fecha, pero la fila sigue viva). Sin esto, borrar por "no está en la ventana" borraría vivos. */
async function existsInReplicaFull(local, table, pk, rows, keyExpr) {
  const found = new Set();
  const pkList = pk.map(qid).join(', ');
  const B = 800;
  for (let i = 0; i < rows.length; i += B) {
    const chunk = rows.slice(i, i + B);
    const binds = chunk.flatMap((r) => pk.map((k) => r[k]));
    const ph = chunk.map((_, ix) => `(${pk.map((__, j) => `$${ix * pk.length + j + 1}`).join(',')})`).join(',');
    const res = await local.query(`SELECT ${keyExpr} AS _k FROM md.${qid(table)} WHERE (${pkList}) IN (${ph})`, binds);
    for (const r of res.rows) found.add(r._k);
  }
  return found;
}

// ⛔ [VL.11] `client: prod` EN LOS DOS `ship()` — sin eso este carril no puede escribir
// cuando el sink es `pg`. Medido el 2026-09-23 al mover la ingesta a `md`:
//     sink(pg): feed 'raw-upsert' requiere un Client de pg conectado
//     huecos 0 · repuestas 0 · errores 38
// `sink.ship()` en modo `pg` aplica EN PROCESO y necesita el Client del importer; en modo
// `http` no, porque manda el changeset por la red. Este archivo nacio con el sink `http`
// (Railway cobraba egress por el proxy publico) y nunca ejercito la otra rama.
// ⚠️ `prod` ya estaba en el alcance: `pasada()` lo abre y lo pasa. Faltaba pasarlo un nivel
// mas. Lo mismo hace `replicate-ods-live.js:254`, que por eso si funcionaba.
async function reconcile(local, prod, code, table) {
  if (!RECENT_COL[table] && !SIN_VENTANA) return { suc: code, tabla: table, skip: 'sin columna de fecha de negocio' };

  // ⛔ `[ODS.2]` El freno del modo chicas: se MIDE el tamaño en el ODS, no se confía en la lista.
  // Una tabla grande acá compararía millones de llaves por rama y por pasada.
  if (CHICAS) {
    const mb = (await prod.query(
      `SELECT coalesce(pg_total_relation_size(to_regclass($1)) / 1048576.0, 0) AS mb`,
      [`kepler_ods.${table}`])).rows[0].mb;
    if (Number(mb) > CHICAS_MAX_MB) {
      return { suc: code, tabla: table, skip: `${Math.round(mb)} MB > ${CHICAS_MAX_MB} MB — NO es tabla chica, usá ventana` };
    }
  }

  const meta = await tableMeta(local, table);
  if (!meta) return { suc: code, tabla: table, skip: 'no existe en el replica' };
  if (!meta.pk.length) return { suc: code, tabla: table, skip: 'sin PK' };
  // `[ODS.2]` Antes de comparar NADA: si la PK no es comparable, el veredicto sería falso en las dos
  // direcciones (falta y sobra la misma fila) y `--delete-sobrantes` borraría vivos.
  const pkChk = await pkNoComparable(meta, local, prod, table, code);
  if (pkChk.motivo) return { suc: code, tabla: table, skip: pkChk.motivo };

  const pkList = meta.pk.map(qid).join(', ');
  // Misma ventana en los DOS lados (replica y ODS comparten columnas): kdm1 = c9 OR c68.
  // `--full` y `--chicas` la ignoran: comparan la tabla COMPLETA. La diferencia entre los dos es
  // si REPONEN (ver `faltan` más abajo), no cómo delimitan el universo.
  const ventana = SIN_VENTANA ? 'TRUE' : recentWindowSql(table, meta.cols, DAYS);
  if (!ventana) return { suc: code, tabla: table, skip: 'columna de fecha no es date/timestamp en el replica' };
  const wLoc = SIN_VENTANA ? '' : `WHERE ${ventana}`;
  const wOds = SIN_VENTANA ? '' : `AND ${ventana}`;

  const keyExpr = pkKeyExpr(meta, pkChk.fechaCols);
  // La llave EXACTA (timestamp entero) desempata dentro de un grupo de dia duplicado.
  const keyExprExact = pkKeyExpr(meta, null);
  // ⛔ El timestamp se lee como TEXTO, no como Date: el driver devuelve un Date de JS y al
  // mandarlo de vuelta lo reescribe con huso — que es EXACTAMENTE el bug que estamos limpiando.
  const tsSel = [...(pkChk.fechaCols || [])].map((k) => `, ${qid(k)}::text AS ${qid('_t_' + k)}`).join('');
  const loc = (await local.query(`SELECT ${pkList}, ${keyExpr} AS _k, ${keyExprExact} AS _x FROM md.${qid(table)} ${wLoc}`)).rows;
  // Freno #1: una réplica que devuelve 0 filas en el scope NO prueba "todo se borró en origen" —
  // prueba réplica rota/vacía. Con el ODS lleno, borrar por esto lo vaciaría. Nunca se borra así.
  if (!loc.length) return { suc: code, tabla: table, local: 0, faltan: 0, ...(DELETE_SOB ? { skip_delete: 'replica 0 filas en scope — NO se borra (posible replica rota)' } : {}) };

  // El ODS es multi-sucursal: SIEMPRE filtrar por `sucursal`, o se compara contra las 7 ramas.
  const pro = (await prod.query(
    `SELECT ${pkList}, ${keyExpr} AS _k, ${keyExprExact} AS _x${tsSel} FROM kepler_ods.${qid(table)} WHERE btrim(sucursal)=$1 ${wOds}`, [code])).rows;
  const presentes = new Set(pro.map((r) => r._k));
  const locales = new Set(loc.map((r) => r._k));
  // `--full` no repone (sería re-ship masivo sobre tablas de millones). `--chicas` SÍ: su universo
  // está acotado por el freno de tamaño de arriba, así que reponer es barato y es justo el objetivo.
  const faltan = FULL ? [] : loc.filter((r) => !presentes.has(r._k));
  const sobran = pro.filter((r) => !locales.has(r._k));
  const extra = sobran.length
    ? { sobrantes: sobran.length, ej_sobrantes: sobran.slice(0, 3).map((r) => r._k).join(' ') }
    : {};

  // ── PROPAGACIÓN DE DELETE (OBS.11, gated) — reemplaza al WAL-CDC como propagador de DELETE ──
  // En modo ventana re-confirma cada sobrante contra la tabla COMPLETA del replica: uno que sigue ahí
  // salió de la ventana por fecha (NO borrado) → no se toca. En --full, `sobran` YA es la comparación
  // completa. Freno #2: nunca borrar más de MAX_DELETE_FRAC del ODS de esa tabla×rama en una pasada.
  if (DELETE_SOB && sobran.length) {
    // Sin ventana (`--full` o `--chicas`), `sobran` YA es la comparación completa: no hay artefacto
    // de ventana que re-confirmar. Con ventana sí, y por eso se re-chequea contra la tabla entera.
    const confirmadas = SIN_VENTANA
      ? sobran
      : await (async () => {
        const found = await existsInReplicaFull(local, table, meta.pk, sobran, keyExpr);
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
        await sink.ship('raw-delete', { rows: chunk, tenantId: TENANT, meta: delMeta, client: prod });
        borrados += chunk.length;
      }
      extra.borrados = borrados;
    } else if (confirmadas.length) {
      extra.borrarian = confirmadas.length; // dry-run
    }
  }


  // ── DEDUP DE PK CON FECHA (OBS.12, gated) ────────────────────────────────────────────────
  // ⭐ Un UPDATE en Kepler puede aterrizar en el ODS como INSERT. `c2` está en la PK y existen DOS
  // renderizados del mismo instante: el poll escribía +6 h hasta el 2026-09-23 y 00:00 desde
  // entonces. El UPSERT no reconoce la fila como la misma, así que la INSERTA — y el ODS se queda
  // con el ANTES y el DESPUÉS de la misma póliza, los dos sumando.
  // Medido 2026-09-29 en `kdc22608`: el folio 25097 está a las 06:00 con $25,755.15 y a las 00:00
  // con $0.00 y concepto `BAJA` — Kepler la canceló y el ODS conserva la versión viva.
  // ⛔ `--delete-sobrantes` NO lo arregla: con la llave por día la fila SÍ existe en el origen, así
  // que no es sobrante. Es un problema de IDENTIDAD, no de borrado. Son defectos distintos.
  // ⭐ Cuál sobra no se decide por regla ("la de las 06:00"): lo decide el ORIGEN. Se conserva la
  // copia cuyo timestamp EXACTO está en el replica y se borran las otras. Si NINGUNA empareja, no
  // se toca nada y se reporta: ahí no sabemos cuál es la viva, y adivinar borra dinero bueno.
  if (pkChk.fechaCols && pkChk.fechaCols.size && pro.length) {
    const exactosOrigen = new Set(loc.map((r) => r._x));
    const porDia = new Map();
    for (const r of pro) { const a = porDia.get(r._k); if (a) a.push(r); else porDia.set(r._k, [r]); }
    const stale = [];
    let ambiguos = 0;
    for (const rows of porDia.values()) {
      if (rows.length < 2) continue;
      const vivas = rows.filter((r) => exactosOrigen.has(r._x));
      if (!vivas.length) { ambiguos++; continue; }
      for (const r of rows) if (!exactosOrigen.has(r._x)) stale.push(r);
    }
    if (ambiguos) extra.dup_sin_original = ambiguos;
    if (stale.length) {
      extra.dup_stale = stale.length;
      // Mismo freno que el DELETE: una réplica rota haría parecer stale a medio ODS.
      if (stale.length > MAX_DELETE_FRAC * pro.length) {
        extra.dedupe_abortado = `${stale.length}/${pro.length} (${(100 * stale.length / pro.length).toFixed(0)}%) > ${(100 * MAX_DELETE_FRAC).toFixed(0)}% — ABORTADO, revisar a mano`;
      } else if (DEDUPE && APPLY) {
        const dupMeta = { table, pk: meta.pk, columns: [{ name: 'sucursal', type: 'text' }, ...meta.cols.map((c) => ({ name: c.column_name, type: mapType(c.data_type) }))] };
        let borrados = 0;
        for (let i = 0; i < stale.length; i += SHIP_BATCH) {
          const chunk = stale.slice(i, i + SHIP_BATCH).map((r) => {
            const o = { sucursal: code };
            // El timestamp va como TEXTO (`_t_<col>`): Postgres lo castea del literal y no hay huso
            // de por medio. Mandar el Date de JS reintroduciría el corrimiento que venimos a limpiar.
            for (const k of meta.pk) o[k] = Object.prototype.hasOwnProperty.call(r, '_t_' + k) ? r['_t_' + k] : r[k];
            return o;
          });
          await sink.ship('raw-delete', { rows: chunk, tenantId: TENANT, meta: dupMeta, client: prod });
          borrados += chunk.length;
        }
        extra.dup_borrados = borrados;
      } else if (DEDUPE) {
        extra.dup_borrarian = stale.length; // dry-run
      }
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
    if (rows.length) { await sink.ship('raw-upsert', { rows, tenantId: TENANT, meta: shipMeta, client: prod }); enviadas += rows.length; }
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

// Umbral de VOLUMEN de huecos. Cada pasada lee el replica y DESPUÉS prod: lo que se creó en ese
// intervalo se ve "ausente" sin serlo.
//
// ⭐ SUBIDO DE 50 A 1000 EL 2026-09-22, CON LA MEDICIÓN AL LADO. El 50 estaba dentro del ruido:
// sobre 1,217 corridas de 14 días la distribución de `huecos` es p50=5 · p90=115 · p95=182 ·
// p99=503 · max=14,479, o sea que 280 corridas (23 %) cruzaban el umbral. Una de cada cuatro
// filas del tablero salía en ROJO — y en las 359 corridas de los últimos 4 días **ni una sola**
// dejó un hueco sin reponer. Es el mismo argumento que este archivo ya escribió tres renglones
// más abajo para `sobrantes`: "un rojo permanente que nadie atiende enseña a ignorar el tablero".
// 1000 deja pasar el régimen medido y sigue atrapando los 6 picos de 1,217 (0.5 %).
const ALERTA = Math.max(1, Number(process.env.ODS_RECONCILE_ALERT) || 1000);

// Umbral de SOBRANTES, aparte y APAGADO por default (0 = sólo reportar en la nota, nunca poner rojo).
// Deliberado: todavía no está medido cuánto de este número es DELETE sin propagar y cuánto es la fila
// que se salió de la ventana por cambio de fecha de negocio. Encender una alarma con un piso
// desconocido fabrica un rojo permanente, y un rojo permanente que nadie atiende enseña a ignorar el
// tablero — es justo lo que acabábamos de limpiar. Se sube a un número real cuando haya semanas de
// observación, poniendo ODS_SOBRANTES_ALERT en ops/vl/docker-compose.yml.
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
    // ⭐ EL ROJO ES "NO CERRÓ EL HUECO", NO "ENCONTRÓ HUECOS". Encontrarlos y reponerlos es el
    // TRABAJO de este carril: ponerlo en rojo por hacer su trabajo es el falso rojo que el
    // comentario de ALERTA_SOBRANTES (abajo) ya había identificado para la otra columna.
    // Y el texto del error decía "el carril esta perdiendo filas" sin medirlo — medido el
    // 2026-09-22: en 359 corridas de 4 días, `huecos == repuestas` SIEMPRE. No perdía nada.
    // ⚠️ `sinReponer` sólo tiene sentido con --apply. En dry-run `repuestas` es 0 por
    //    construcción, así que la resta daría "todo sin reponer" y el rojo sería falso en la
    //    dirección contraria — que es cómo suelen fallar los arreglos de alarmas.
    const sinReponer = APPLY ? (r.huecos - r.repuestas) : 0;
    const malo = sinReponer > 0 || r.errores > 0 || sobranMal || r.abortados > 0 || r.huecos > ALERTA;
    await c.query(`
      INSERT INTO analytics.cron_runs
        (tenant_id, job_key, label, last_start, last_finish, status, rows_affected, duration_ms, note, error, host, updated_at)
      VALUES ($1,'${HB_KEY}',${FULL ? "'Reconciliador ODS --full (backlog)'" : CHICAS ? "'Reconciliador ODS --chicas (tablas sin fecha)'" : "'Reconciliador ODS (completitud)'"}, now() - ($2::int || ' ms')::interval, now(),
              $3, $4, $2, $5, $6, $7, now())
      ON CONFLICT (tenant_id, job_key) DO UPDATE SET
        last_start=EXCLUDED.last_start, last_finish=EXCLUDED.last_finish, status=EXCLUDED.status,
        rows_affected=EXCLUDED.rows_affected, duration_ms=EXCLUDED.duration_ms,
        note=EXCLUDED.note, error=EXCLUDED.error, host=EXCLUDED.host, updated_at=now()`,
    [TENANT, ms, malo ? 'error' : 'ok', r.repuestas,
      `ventana ${FULL ? 'FULL' : CHICAS ? 'CHICAS' : DAYS + 'd'} · huecos ${r.huecos} · repuestas ${r.repuestas} · sobrantes ${r.sobrantes}${DELETE_SOB ? ` · borrados ${r.borrados}` : ''}${r.abortados ? ` · ABORTADOS ${r.abortados}` : ''} · errores ${r.errores}`,
      malo ? [
        sinReponer > 0 ? `${sinReponer} de ${r.huecos} filas ausentes NO se repusieron — el carril esta perdiendo filas` : null,
        r.huecos > ALERTA ? `${r.huecos} huecos en la ventana (se repusieron ${r.repuestas}) — muy por encima del regimen medido (p99=503 sobre 1217 corridas de 14 dias): revisar el carril PRIMARIO, no este` : null,
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
  console.log(`reconcile-ods-window · ${FULL ? 'FULL (backlog)' : CHICAS ? `CHICAS (sin ventana, tope ${CHICAS_MAX_MB} MB)` : `ventana ${DAYS}d`} · tablas ${TABLES.join(',')} · ${APPLY ? 'APPLY' : 'dry-run'}${DELETE_SOB ? ' · DELETE-SOBRANTES' : ''}${WATCH_SEC ? ` · watch ${WATCH_SEC}s` : ''}\n`);

  if (!WATCH_SEC) {
    const t0 = Date.now();
    const out = await pasada(destUrl);
    console.table(out);
    const r = resumen(out);
    console.log(`\nfilas ausentes en el ODS: ${r.huecos}${APPLY ? ` · repuestas: ${r.repuestas}` : ' (dry-run: nada se envió)'}`);
    console.log(`filas de MÁS en el ODS: ${r.sobrantes}${DELETE_SOB
      ? (APPLY ? ` · BORRADAS: ${r.borrados}` : ` · borrarían: ${r.borrarian}`) + (r.abortados ? ` · ABORTADOS: ${r.abortados} (fracción > ${(100 * MAX_DELETE_FRAC).toFixed(0)}%)` : '')
      : ' — sólo se reportan (usá --delete-sobrantes para propagar el DELETE)'}`);
    // OBS.11 — el barrido agendado (ods-reconcile-full) DECLARA su entrega con latido propio
    // (ODS_RECONCILE_HB_KEY=cdc_reconcile_full). Las corridas manuales no lo setean → no laten,
    // así no pisan el latido del carril continuo. Un job de limpieza sin latido es mudo.
    if (process.env.ODS_RECONCILE_HB_KEY) await latir(destUrl, r, Date.now() - t0);
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
