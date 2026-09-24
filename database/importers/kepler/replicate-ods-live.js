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
 *      ODS_LIVE_BRANCHES (default 00,01,02,03,04,05,06; 00=oficinas/CEDIS-finanzas @192.168.9.95.
 *        Su réplica local kepler_md_00 está PENDIENTE (runbook §8) → hasta que exista, el ciclo la
 *        SALTA con "no conecta — skip" (inofensivo). Al crear la subscription, se activa sola.)
 *      FEEDS_SINK=http + FEEDS_INGEST_URL + FEEDS_INGEST_KEY · CRON_TENANT_ID
 *      ODS_READ_BATCH (5000) · ODS_SHIP_BATCH (5000)
 *      ODS_HASH_RESYNC_SEC (3600) · ODS_HASH_RESYNC_TABLES (kdil,kdik) — red de seguridad del
 *        carril hash: cada N s esa tabla ignora el shadow una pasada y re-shipea todo, para
 *        recuperar filas que el shadow dio por enviadas y el destino nunca aplicó.
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

const TABLES = (ONLY || process.env.KP_ODS_TABLES || 'kdm1,kdm2,kdii,kdil,kdig,kdik,kdib,kdb1,kdid,kdij,kdue,kduv,kdud,kdm_rutas,kdm_transporte,kdm_chofer,kdpord')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Catálogos mutables (UPDATE in-place) → carril hash. El resto → carril ctid (append-only o grande).
// kdb1 (catálogo de cuentas de banco) es chico y mutable → hash; lo consume el libro de bancos Kepler.
const HASH_TABLES = new Set(
  (process.env.ODS_HASH_TABLES || 'kdii,kdil,kdik,kdig,kdid,kduv,kdud,kdb1,kdm_rutas,kdm_transporte,kdm_chofer')
    .split(',').map((s) => s.trim()).filter(Boolean));
const READ_BATCH = Math.max(500, Number(process.env.ODS_READ_BATCH) || 5000);
const SHIP_BATCH = Math.max(500, Number(process.env.ODS_SHIP_BATCH) || 5000);

// MODO ESPEJO COMPLETO (`--tables=*` o KP_ODS_TABLES=*): trae TODAS las md.* del replica.
// Las 335 tablas tienen PK en el replica (indisprimary) → tableMeta la deriva sola. En este modo
// el carril por defecto es HASH (universal: re-lee y compara md5, no pierde filas como el ctid),
// salvo la whitelist CTID (grandes append-only, donde el ctid es barato y seguro).
const ALL_MODE = ONLY === '*' || process.env.KP_ODS_TABLES === '*';
const CTID_TABLES = new Set(
  (process.env.ODS_CTID_TABLES || 'kdm1,kdm2,kdij,kdue,kdpord,kdm3,kdm4,kdm5,kdm6,kdm7,kdm8,kdm9,kdmx,kdmx_25,kdmx_26,kdlogmov,orglogtbl_24,orglogtbl_25,orglogtbl_26,pos95historico')
    .split(',').map((s) => s.trim()).filter(Boolean));
// Soporte GLOB de prefijo (ej. `kdc2*` = todas las pólizas mensuales kdc2YYMM) en KP_ODS_TABLES y
// ODS_HASH_TABLES. El `*` solo = ALL_MODE (arriba). Permite sumar las tablas de finanzas de oficinas
// (kdc2*, kdco, kdc3, kdpv_folio_caja) al set del launcher SIN espejo completo → costo acotado, y
// kdc2YYMM (rota por mes) se auto-cubre. Se expande por-rama (cada replica resuelve sus propios kdc2*).
const _globs = (arr) => arr.filter((t) => t !== '*' && t.includes('*'))
  .map((t) => new RegExp('^' + t.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
const _lits = (arr) => arr.filter((t) => t !== '*' && !t.includes('*'));
const TABLE_GLOBS = _globs(TABLES);
const TABLE_LITS = _lits(TABLES);
const HASH_GLOBS = _globs([...HASH_TABLES]);
const matchesGlob = (name, globs) => globs.some((re) => re.test(name));

// EXCLUDE (blocklist, glob-capable): tablas que ESTA corrida NO debe tocar. Uso principal: la tarea de
// ESPEJO COMPLETO LENTO (`KP_ODS_TABLES=*` @5min) excluye el set del HOT loop (kdm1/kdm2/… + kdc2*) para
// NO pelear el estado compartido en el mismo replica (watermark ctid `ods.ctl` + hashes `ods.shadow`);
// así el hot loop @15s mantiene venta/stock frescos y el lento barre el resto (catálogos + las que un
// full-mirror viejo dejó CONGELADAS: kdmx*/orglog*/bitacora) sin doble-ship ni carrera de watermark.
const EXCLUDE = (process.env.ODS_EXCLUDE_TABLES || '').split(',').map((s) => s.trim()).filter(Boolean);
const EXCLUDE_GLOBS = _globs(EXCLUDE);
const EXCLUDE_LITS = new Set(_lits(EXCLUDE));
const isExcluded = (table) => EXCLUDE_LITS.has(table) || matchesGlob(table, EXCLUDE_GLOBS);

/** Lista de tablas a sincronizar para un replica dado (ALL_MODE = todo el schema; con globs, se expanden). */
async function tablesFor(p) {
  let list;
  if (ALL_MODE) {
    list = (await p.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='md' AND table_type='BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
  } else if (!TABLE_GLOBS.length) {
    list = TABLES;
  } else {
    const all = (await p.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='md' AND table_type='BASE TABLE'`)).rows.map((r) => r.table_name);
    const out = new Set(TABLE_LITS);
    for (const t of all) if (matchesGlob(t, TABLE_GLOBS)) out.add(t);
    list = [...out].sort();
  }
  return EXCLUDE.length ? list.filter((t) => !isExcluded(t)) : list;
}
/** ¿tabla va por carril hash? ALL_MODE: todo hash salvo whitelist ctid. Si no: set HASH (literal o glob). */
const isHashTable = (table) => (ALL_MODE ? !CTID_TABLES.has(table) : (HASH_TABLES.has(table) || matchesGlob(table, HASH_GLOBS)));

// RED DE SEGURIDAD del carril ctid (bug 2026-08-19): el ctid NO es monótono en un SUBSCRIBER de
// replicación lógica (el heap reusa espacio) → filas nuevas caen por debajo del watermark y
// `ctid > wm` las SALTA en silencio (verificado: ODS perdía 233 kdm1 de PH, incl. recepciones
// 394/396/398). Fix additivo: tras el carril ctid, re-enviar por UPSERT idempotente la VENTANA
// RECIENTE por fecha de negocio → cualquier fila saltada se recupera en ≤1 pasada. Barato (la
// ventana es chica) y no toca el camino ctid. Throttle por tabla×sucursal para acotar egress.
const SAFETY_DAYS = Number(process.env.ODS_SAFETY_DAYS || 3);
const SAFETY_INTERVAL_MS = Number(process.env.ODS_SAFETY_INTERVAL_SEC || 300) * 1000;
// Columna de FECHA DE NEGOCIO por tabla ctid (la red de seguridad re-envía la ventana reciente por
// ella). OJO: NO es c9 en todas — c9 solo es fecha en kdm1; en kdm2 c9=CANTIDAD (double), en
// kdij/kdue/kdpord c9=numérico/varchar. Verificado 2026-08-21: kdm2.c32 ≡ fecha del header
// (76846/76847 = 99.999% mismo día, 0 nulls), kdij.c10, kdue.c7, kdpord.c6 = timestamps de negocio.
// BUG PREVIO (c9 en todas): la red hacía `c9 >= current_date-N` → "operator does not exist:
// double precision/numeric/varchar >= date" (150k veces en el log) → kdm2/kdij/kdue quedaban SIN
// red de seguridad, expuestas al skip silencioso del ctid (líneas de venta faltantes).
// 2026-09-09: la ventana vive en ../lib/ods-recent-window.js (compartida con reconcile-ods-window.js).
// Para kdm1 es `c9 OR c68` (fecha de CAPTURA): con sólo c9, un pago capturado hoy con fecha valor
// atrasada >3 días que el ctid saltó NO se recuperaba jamás (17 X-D-26 de Oficinas ausentes en prod).
const { recentWindowSql } = require('../lib/ods-recent-window');
const _lastSafety = new Map();

// RED DE SEGURIDAD del carril HASH (bug 2026-09-02): el shadow se marca para TODAS las filas
// enviadas, sin poder confirmar que el destino las aplicó — y NO se puede validar por `rowCount`,
// porque el upsert del ODS filtra las idénticas (medido: 2804 enviadas → 897 escritas es lo NORMAL).
// Si un ship se pierde parcialmente, esas filas quedan con el shadow ADELANTADO y NUNCA se
// reintentan: sólo se corrigen si el dato vuelve a cambiar por sí solo. Por eso el daño se concentra
// en las sucursales de baja rotación — medido en prod: `04` Yurécuaro tenía 897 filas de `kdil`
// stale (existencia derivada del ODS acertaba 85.2% vs POS, contra 100% de las demás), y el
// resync `--full` la puso en 100%. Fix additivo: cada RESYNC_SEC ignorar el shadow una pasada
// (equivalente a `--full` de esa tabla×sucursal) → auto-sanante, sin intervención manual.
// Acotado por whitelist para NO pagar egress de re-shipear catálogos grandes (kdii 37MB, kdc2*):
// por default sólo las tablas de EXISTENCIA, que son chicas y son las que mueven dinero (el pedido).
// OJO: el estado del throttle va EN LA DB del replica (ods.hash_resync), no en memoria. El runner
// (run-ods-live-loop.cmd) lanza un PROCESO NUEVO cada ODS_LOOP_SECONDS, así que un Map en memoria
// arranca vacío en cada pasada y el resync se dispararía SIEMPRE (cada 15 s), justo el egress que
// esto evita. Con la tabla, el intervalo se respeta entre procesos.
const HASH_RESYNC_SEC = Number(process.env.ODS_HASH_RESYNC_SEC || 3600);
// ⭐ [NORM.3b] ENTRA `kdii`, Y LA RAZÓN ES QUE LA PREMISA DE ARRIBA CADUCÓ.
// El párrafo anterior excluye a kdii textualmente "para NO pagar egress de re-shipear catálogos
// grandes (kdii 37MB)". Eso era correcto cuando el destino era Railway y cada re-ship cruzaba
// internet. Desde [VL.11] el destino es `pg-prod` en la MISMA máquina que las réplicas: el egress
// que justificaba la exclusión es hoy loopback.
// Y el costo de NO tenerla está medido, el 2026-09-23: 460 filas de kdii en las 9 ramas publicaban
// un precio que la sucursal ya no cobra —329 de ellas MÁS BARATO que el real, una en $0.00— y el
// carril decía `0 candidatas` en las nueve. No era rezago: estaban ATASCADAS, y el único motivo
// por el que kdil/kdik NO lo estaban es que son las dos únicas que sí tenían esta red.
// ⛔ `kdc2*` sigue afuera a propósito: son las pólizas por mes, crecen sin techo y no publican precio.
const HASH_RESYNC_TABLES = new Set(
  (process.env.ODS_HASH_RESYNC_TABLES || 'kdil,kdik,kdii').split(',').map((s) => s.trim()).filter(Boolean));

// ── [NORM.3b] EL SHADOW NO SABÍA A DÓNDE HABÍA MANDADO ───────────────────────────────────────
// `ods.shadow` es (table_name, pk_text, h): estado POR RÉPLICA, sin una sola columna que diga a qué
// destino se shipeó. Mientras hubo un solo destino eso fue invisible. Cuando prod se mudó de Railway
// a `pg-prod` (2026-09-22/23), el shadow siguió contestando "esa fila ya la mandé" — y era CIERTO:
// la había mandado al destino viejo. El carril quedó convencido de no tener nada pendiente contra un
// destino que nunca vio esas filas, y no hay reintento posible: sólo se corrige si el dato cambia solo.
// Acá se guarda la identidad del destino (host/base, JAMÁS la credencial) al lado del shadow; si
// cambia, el carril hash hace UNA pasada ignorando el shadow, que es exactamente `--full`.
const DEST_CAMBIO = new Map(); // code → true cuando este replica detectó destino nuevo
let DEST_IDENT = null;         // 'host:puerto/base' del destino, sin credenciales

const CONN = { connectionTimeoutMillis: 15000, statement_timeout: 300000, query_timeout: 300000, keepAlive: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── LATIDO (OBS.1) ───────────────────────────────────────────────────────────────────────────
// Este carril alimentaba prod y era MUDO: no escribía a `analytics.cron_runs`, así que db-health no
// tenía nada que vigilar. Del 27/08 al 02/09/2026 estuvo parado 6 días y la única señal fue el mtime
// de un .log. 23,200 filas de catálogo sin shipear (10,248 de costo) y la app publicando precio,
// costo y margen con toda confianza. Se descubrió por accidente.
//
// ⚠️ VARIABLE PROPIA a propósito. `cron-heartbeat.js` toma su conexión de `DATABASE_URL_NEW`, y en
// ESTE script esa var apunta al CONTENEDOR DE REPLICAS (:5433) — no a prod. Un latido escrito ahí es
// invisible para el tablero, que vive en prod: el modo de falla exacto que la fase busca eliminar.
// Ver GOTCHAS §17 ("DATABASE_URL_NEW significa tres cosas") y §18.
// Fallback a `FLEET_DB_URL`, que es el handle de prod verificado (reference_prod_db_connection_topology).
const HB_URL = process.env.ODS_HB_URL || process.env.FLEET_DB_URL || null;
// Un carril = un umbral. El hot loop (@15s) y el espejo lento (@300s) no pueden compartir alarma.
const HB_KEY = process.env.ODS_HB_KEY || (ALL_MODE ? 'ods_live_mirror' : 'ods_live_hot');
const HB_LABEL = ALL_MODE ? 'ODS espejo completo (replica→prod)' : 'ODS carril vivo (replica→prod)';

// El latido viaja a Railway por internet: es la ÚNICA conexión del script que sale de la LAN,
// y por eso la más expuesta a un socket que se queda a medias. `pg` NO trae timeout de conexión
// por default — sin `connectionTimeoutMillis` un `connect()` contra un peer que no contesta ni
// resetea espera PARA SIEMPRE, y como el latido es lo primero de cada ciclo, el `for(;;)` del
// modo --watch queda clavado con el proceso vivo y CPU 0%. Eso fue el cuelgue del 04-09-2026:
// última línea `latido (end) falló: Connection terminated unexpectedly` y 15 h de silencio con
// Docker reportando `healthy`. `HB_CONN` le pone reloj a las dos conexiones de telemetría.
const HB_CONN = { ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 30000, query_timeout: 30000 };

/**
 * ⛔ `[ODS.2]` CERRAR UNA CONEXIÓN TAMBIÉN SE CUELGA — y a este archivo la lección no le llegó.
 *
 * `client.end()` de node-postgres NO tiene timeout: manda el mensaje 'X' y espera a que el peer
 * cierre. Si el peer se fue sin completar el cierre (un firewall/NAT en el camino, cosa habitual
 * con 9 sucursales detrás de VPN), el socket queda en FIN_WAIT1 y el `await` **no vuelve nunca**.
 *
 * Medido el 2026-09-24 en `md`, dos veces seguidas y en el MISMO punto: una reparación `--full`
 * terminó la rama 01, entró al `finally` que cierra su conexión, y ahí murió. La primera corrida
 * quedó **13 h 14 min** con el log mudo, CPU 0.00%, 360 MB de memoria, el contenedor `healthy` y
 * ninguna consulta activa en la base. Las réplicas respondían en 20-30 ms: el problema no era la
 * rama siguiente, era el cierre de la anterior. La segunda corrida se colgó igual, en la misma
 * transición, lo que descartó la casualidad.
 *
 * ⚠️ El arreglo ya existía en el repo desde el 2026-09-11 — `live-tickets-poller.js:65` lo trae
 * con su comentario, tras el mismo cuelgue en ese carril. Nunca se portó acá, al carril que
 * alimenta prod. Es la forma exacta de deuda que ADR-056 nombra: *un mecanismo que hay que
 * acordarse de aplicar se cumple tanto como la revisión alcance a mirar.* Por eso ahora es una
 * función y **los seis** cierres del archivo pasan por ella, no sólo el que falló.
 *
 * Perder un cierre ordenado no cuesta nada: el peer recoge el socket igual. Colgar el carril
 * cuesta todo, y lo cuesta EN SILENCIO — que es lo caro.
 */
async function cerrar(c) {
  if (!c) return;
  let t;
  try {
    await Promise.race([
      c.end(),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('end() no volvió en 5s')), 5000); }),
    ]);
  } catch {
    try { c.connection?.stream?.destroy(); } catch { /* ya no hay socket que matar */ }
  } finally { clearTimeout(t); }
}

/** Latido DIRECTO a prod. Nunca tira: un latido que rompe el feed es peor que no tenerlo. */
async function latir(fase, { status, rows, note, error, ms } = {}) {
  if (!HB_URL) return;
  const c = new Client({ connectionString: HB_URL, ...HB_CONN });
  try {
    await c.connect();
    if (fase === 'begin') {
      // Sana una corrida colgada antes de abrir la nueva (mismo contrato que lib/cron-heartbeat).
      await c.query(
        `UPDATE analytics.cron_runs SET status='error', last_finish=now(),
                error=COALESCE(error,'la corrida anterior no reportó cierre (proceso caído)')
          WHERE tenant_id=$1 AND job_key=$2 AND status='running'`, [TENANT, HB_KEY]);
      await c.query(`
        INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, status, host, updated_at)
        VALUES ($1,$2,$3, now(), 'running', $4, now())
        ON CONFLICT (tenant_id, job_key) DO UPDATE SET
          label=EXCLUDED.label, last_start=now(), status='running', host=EXCLUDED.host, updated_at=now()`,
      [TENANT, HB_KEY, HB_LABEL, require('os').hostname()]);
    } else {
      await c.query(`
        UPDATE analytics.cron_runs
           SET last_finish=now(), status=$3, rows_affected=$4, duration_ms=$5,
               note=left($6,500), error=left($7,500), updated_at=now()
         WHERE tenant_id=$1 AND job_key=$2`,
      [TENANT, HB_KEY, status || 'ok', rows ?? null, ms ?? null, note || null, error || null]);
    }
  } catch (e) { console.error(`  latido (${fase}) falló: ${e.message.slice(0, 70)}`); }
  finally { await cerrar(c); }
}

/**
 * [OBS.3.2] Marca por SUCURSAL de que este carril la **revisó**.
 *
 * El latido de arriba agrega: dice "7/7 ramas". Eso queda verde con 1/1 si alguien deja el
 * contenedor corriendo con `--branch=03`, y verde también si una tabla se cae de `KP_ODS_TABLES`.
 * Esta marca es por rama y lleva cuántas tablas se revisaron, así que la deriva de configuración
 * deja de ser invisible — que es la clase de cambio invisible que costó los seis días.
 *
 * `last_check_at` avanza SÓLO si la pasada de esa rama cerró bien: si el replica no conectó, la
 * rama no fue revisada y registrarlo como revisión sería mentir en la única fila que lo probaría.
 * Una rama que nunca se pudo revisar queda con `last_check_at` en NULL, y el sensor la trata como
 * lo peor — no como "sin datos".
 *
 * Va en el mismo viaje que el latido y no tira nunca: esto vigila el feed, no lo condiciona.
 */
async function marcarRamas(marcas) {
  if (!HB_URL || !marcas.length) return;
  const c = new Client({ connectionString: HB_URL, ...HB_CONN });
  try {
    await c.connect();
    for (const m of marcas) {
      await c.query(`
        INSERT INTO analytics.ods_branch_checks
               (tenant_id, lane, sucursal, last_check_at, tables_checked, rows_shipped, last_error)
        VALUES ($1,$2,$3, CASE WHEN $7::text IS NULL THEN now() ELSE NULL END, $4, $5, $6)
        ON CONFLICT (tenant_id, lane, sucursal) DO UPDATE SET
          -- Sólo una pasada limpia mueve la marca. Con error se conserva la anterior: así el
          -- sensor ve cuánto lleva esa rama SIN revisarse de verdad, no cuándo se intentó.
          last_check_at  = CASE WHEN $7::text IS NULL THEN now()
                                ELSE analytics.ods_branch_checks.last_check_at END,
          tables_checked = EXCLUDED.tables_checked,
          rows_shipped   = EXCLUDED.rows_shipped,
          last_error     = EXCLUDED.last_error`,
      [TENANT, HB_KEY, m.suc, m.tablas || 0, m.filas || 0, m.error || null, m.error || null]);
    }
  } catch (e) { console.error(`  marca por rama falló: ${e.message.slice(0, 70)}`); }
  finally { await cerrar(c); }
}

// Destino. En FEEDS_SINK=http (prod) el ship va por HTTP y no se usa cliente. En FEEDS_SINK=pg
// (on-prem / test) se aplica directo con este cliente contra KP_DEST_URL (default = replicas base).
const DEST_URL = process.env.KP_DEST_URL || null;
let DEST = null; // Client de pg cuando el sink es 'pg'; null en http.
const ship = (rows, meta) => sink.ship('raw-upsert', { rows, tenantId: TENANT, meta, client: DEST });

// Base de conexión al contenedor de replicas (localhost:5433). Las 7 ramas siguen la MISMA
// convención `kepler_md_XX` desde el 2026-09-07: la 03 se llamaba `kepler_pilot` (nombre del piloto
// original) y se renombró, junto con el drop de la `md_03` huérfana que llevaba congelada desde el
// 15-jun y a la que nadie escribía ni leía. Había DOS bases con nombre de la 03, una viva y una
// muerta — la trampa perfecta para leer la equivocada; y la excepción estaba copiada a mano en
// NUEVE archivos. Si vuelve a aparecer un nombre fuera de convención, que viva en un solo lugar.
//
// ODS_SOURCE_BASE existe para DESACOPLAR esta base de `DATABASE_URL_NEW`. Esa var la mueve dev
// para apuntar la app a otra base (p. ej. la réplica de pruebas en .245); si el CDC la usa para
// derivar `kepler_md_XX`, se queda buscando los replicas en el server equivocado y **se calla**:
// `cycleAll` loguea "no conecta — skip" por rama y la pasada termina "bien" sin shipear nada.
// Exactamente la clase de falla silenciosa que nos costó 2 días de kepler_ods viejo en prod.
// Se deja `DATABASE_URL_NEW` como fallback por compatibilidad con los runners que aún no la setean.
const SUB_BASE = process.env.ODS_SOURCE_BASE || process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const { replicaDbName: localDbName, BRANCHES: CATALOGO } = require('../lib/kepler-branches'); // convención única
const localUrl = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return u.toString(); };
// 00 incluido (oficinas/CEDIS-finanzas @9.95): first-class en el ODS. Sin su réplica local
// kepler_md_00 todavía → cycleAll la salta ("no conecta — skip"); al crearla se activa sola.
// `[ODS.1]` La lista sale del catálogo canónico, no de una cadena a mano. Acá coincidía con las 9
// ramas, pero era una COPIA: en `reconcile-ods-window.js` la copia se quedó en 7 y el reconciliador
// nocturno dejó de mirar Morelia Madero y Abastos durante meses, sin ninguna señal. Una sucursal
// nueva se agrega en `lib/kepler-branches.js` y llega sola a todos lados.
const BRANCH_CODES = (process.env.ODS_LIVE_BRANCHES || CATALOGO.map((b) => b.code).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
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
async function ensureLocalCtl(p, code, apply) {
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
  // Throttle PERSISTENTE de la red de seguridad del carril hash (ver ODS_HASH_RESYNC_SEC).
  await p.query(`CREATE TABLE IF NOT EXISTS ods.hash_resync (
      table_name text PRIMARY KEY,
      last_at    timestamptz NOT NULL DEFAULT now())`);
  // [NORM.3b] Identidad del DESTINO al que este replica viene shipeando (ver el bloque de arriba).
  await p.query(`CREATE TABLE IF NOT EXISTS ods.sink_ident (
      id     int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      dest   text NOT NULL,
      set_at timestamptz NOT NULL DEFAULT now())`);
  // ⛔ Sin `code` no hay a quién marcarle el cambio; sin `DEST_IDENT` no hay con qué comparar. Lo
  // segundo sólo pasa si el sink no publicó su identidad, y eso se AVISA en vez de quedar mudo:
  // un mecanismo anti-divergencia apagado en silencio se lee igual que uno que dice "todo bien".
  if (!code) return;
  if (!DEST_IDENT) {
    if (!ensureLocalCtl._aviso) { ensureLocalCtl._aviso = true;
      console.log('  ⚠ el sink no publicó su identidad → el candado de "destino nuevo" queda INERTE en esta corrida.'); }
    return;
  }
  const actual = await p.query('SELECT dest FROM ods.sink_ident WHERE id = 1');
  if (!actual.rowCount) {
    // PRIMERA VEZ: se SIEMBRA y NO se resincroniza. A propósito — si el estreno de este código
    // disparara un full de todo el carril hash en las 9 réplicas a la vez, el arreglo sería peor
    // que el problema (en `ods-live-mirror` el carril hash es "todo menos la whitelist ctid", y ahí
    // adentro hay tablas de cientos de miles de filas). El destino de hoy ya quedó verificado a mano.
    await p.query('INSERT INTO ods.sink_ident (id, dest) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [DEST_IDENT]);
    return;
  }
  if (actual.rows[0].dest === DEST_IDENT) return;
  // Claim ATÓMICO, mismo patrón que ods.hash_resync: si hay dos procesos, sólo uno se lleva el full.
  // ⛔ SÓLO CON --apply, misma razón que `ods.hash_resync`: si una corrida en seco se llevara el
  // claim, la corrida real siguiente creería que el destino no cambió y NO resincronizaría — el
  // dry-run habría consumido en silencio justo la señal que existe para no perder filas.
  if (!apply) {
    console.log(`  ⚠ ${code}: DESTINO NUEVO (${actual.rows[0].dest} → ${DEST_IDENT}); en seco no se marca.`);
    return;
  }
  const cambio = await p.query(
    `UPDATE ods.sink_ident SET dest = $1, set_at = now() WHERE id = 1 AND dest IS DISTINCT FROM $1 RETURNING dest`,
    [DEST_IDENT]);
  if (cambio.rowCount) {
    DEST_CAMBIO.set(code, true);
    console.log(`  ⛑ ${code}: DESTINO NUEVO (${actual.rows[0].dest} → ${DEST_IDENT}). El shadow de este `
      + `replica no sabe nada de él → una pasada del carril hash ignorando el shadow.`);
  }
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

  // RED DE SEGURIDAD: re-envía la ventana reciente por fecha (recupera filas que el ctid saltó).
  // Idempotente (raw-upsert) → re-enviar filas ya presentes es inofensivo. Throttle a SAFETY_INTERVAL.
  // Type-guard adentro del helper: sólo columnas que existen y son fecha/timestamp. Si ninguna
  // califica devuelve null y la tabla se queda SIN red de seguridad (degradación limpia) en vez de
  // spamear "operator does not exist: X >= date".
  const ventana = recentWindowSql(table, meta.cols, SAFETY_DAYS);
  if (ventana) {
    const key = `${code}/${table}`;
    const nowMs = Date.now();
    if (full || (nowMs - (_lastSafety.get(key) || 0)) >= SAFETY_INTERVAL_MS) {
      _lastSafety.set(key, nowMs);
      let sbuf = [], sSeen = 0, sChanged = 0;
      const rows = (await p.query(
        `SELECT ${selList} FROM md.${qid(table)} WHERE ${ventana}`)).rows;
      for (const row of rows) {
        const o = { sucursal: code };
        for (const c of meta.cols) o[c.column_name] = row[c.column_name];
        sbuf.push(o); sSeen++;
        if (sbuf.length >= SHIP_BATCH) { const r = await ship(sbuf, shipMeta); sChanged += Number(r.rowCount || 0); sbuf = []; }
      }
      if (sbuf.length) { const r = await ship(sbuf, shipMeta); sChanged += Number(r.rowCount || 0); }
      if (sChanged) console.log(`  ⛑ ${code}/${table} [safety ${SAFETY_DAYS}d]: ${sSeen} revisadas · ${sChanged} recuperadas/actualizadas`);
    }
  }
  return { suc: code, tabla: table, carril: 'ctid', leidas: seen, escritas: changed };
}

/** Carril HASH: catálogos chicos mutables. Delta = filas cuyo md5(fila) difiere del shadow local. */
async function syncHash(p, code, table, meta, { apply, full }) {
  const selList = meta.cols.map((c) => qid(c.column_name)).join(', ');
  const shipMeta = shipMetaOf(table, meta);
  const pkx = pkExpr(meta.pk);
  // Red de seguridad periódica: cada HASH_RESYNC_SEC esta tabla se comporta como `--full` (ignora
  // el shadow) para recuperar filas cuyo ship se perdió y el shadow dio por enviadas. El claim es
  // ATÓMICO y persistente (`ods.hash_resync` en este replica): el UPDATE condicional sólo devuelve
  // fila si de verdad tocaba, así que dos procesos concurrentes no resincronizan lo mismo dos veces.
  // Sólo con --apply: en dry-run no se consume el intervalo.
  let dueResync = false;
  if (apply && HASH_RESYNC_TABLES.has(table)) {
    dueResync = (await p.query(
      `INSERT INTO ods.hash_resync (table_name, last_at) VALUES ($1, now())
       ON CONFLICT (table_name) DO UPDATE SET last_at = now()
         WHERE ods.hash_resync.last_at < now() - ($2 || ' seconds')::interval
       RETURNING table_name`, [table, String(HASH_RESYNC_SEC)])).rowCount > 0;
  }
  const ignoreShadow = full || dueResync || DEST_CAMBIO.get(code) === true;
  // full = ignora shadow (re-shipea todo y reconstruye shadow); útil primera pasada / resync.
  const joinCond = ignoreShadow
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
  // `escritas` < `delta` es NORMAL: el upsert del destino filtra las filas ya idénticas. Lo que
  // importa del resync es justamente lo que escribe — eso es lo que el shadow había perdido.
  console.log(`  ${dueResync ? '⛑' : '✓'} ${code}/${table} [hash${dueResync ? ' resync' : ''}]: ${rows.length} delta · ${changed} escritas`);
  return { suc: code, tabla: table, carril: 'hash', resync: dueResync || undefined, leidas: rows.length, escritas: changed };
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
      const tables = await tablesFor(p);
      for (const table of tables) {
        if (isHashTable(table)) continue;
        const meta = await tableMeta(p, table);
        if (!meta || !meta.pk.length) continue;
        const r = await p.query(`SELECT ctid FROM md.${qid(table)} ORDER BY ctid DESC LIMIT 1`);
        const wm = r.rows.length ? r.rows[0].ctid : '(0,0)';
        await p.query(
          `INSERT INTO ods.ctl (table_name, last_ctid, last_run_at) VALUES ($1,$2, now())
           ON CONFLICT (table_name) DO UPDATE SET last_ctid=EXCLUDED.last_ctid, last_run_at=now()`, [table, wm]);
        console.log(`  ⚑ ${b.code}/${table}: watermark → ${wm}`);
      }
    } finally { await cerrar(p); }
  }
}

/** Un ciclo: cada replica local × tablas, ruteando por carril.
 *  `summary.fallas` = ramas que no se pudieron leer. Antes esto era un `continue` MUDO: una pasada
 *  entera podía shipear CERO (las 7 ramas sin conectar) e imprimir "APPLY hecho." igual. Es la misma
 *  falla silenciosa que tuvo Wincaja 4 días en cero con los dos carriles "online" — ahí se resolvió
 *  agregando las fallas al error del latido (replicate-wincaja-live.js:200-207) y se copia acá. */
async function cycleAll({ apply, full }) {
  const summary = [];
  const fallas = [];
  summary.fallas = fallas;
  // [OBS.3.2] Una marca por rama, para que la deriva de configuración deje de ser invisible.
  const marcas = [];
  summary.marcas = marcas;
  for (const b of BRANCHES) {
    if (ONLY_BRANCH && b.code !== ONLY_BRANCH) continue;
    const p = new Client({ connectionString: b.url, ssl: false, ...CONN });
    try { await p.connect(); }
    catch (e) {
      console.log(`  ⚠ replica ${b.code} (${localDbName(b.code)}): no conecta (${e.message.slice(0, 50)}) — skip`);
      fallas.push(`${b.code}: ${e.message.slice(0, 40)}`);
      // Con error: la marca NO avanza. Esta rama no se revisó, y decir que sí la volvería invisible.
      marcas.push({ suc: b.code, tablas: 0, filas: 0, error: e.message.slice(0, 120) });
      continue;
    }
    let tablas = 0, filas = 0, errTablas = 0;
    try {
      await ensureLocalCtl(p, b.code, apply);
      const tables = await tablesFor(p);
      for (const table of tables) {
        try {
          const meta = await tableMeta(p, table);
          if (!meta) { summary.push({ suc: b.code, tabla: table, skip: 'no existe' }); continue; }
          if (!meta.pk.length) { summary.push({ suc: b.code, tabla: table, skip: 'sin PK' }); continue; }
          const fn = isHashTable(table) ? syncHash : syncCtid;
          const r = await fn(p, b.code, table, meta, { apply, full });
          summary.push(r);
          tablas++; filas += Number(r?.escritas || 0);
        } catch (e) { console.log(`  ✗ ${b.code}/${table}: ${e.message.slice(0, 90)}`); summary.push({ suc: b.code, tabla: table, error: e.message.slice(0, 45) }); errTablas++; }
      }
      // La rama SÍ se revisó (conectó y se recorrieron sus tablas). Si alguna tabla falló se anota
      // en el texto, pero la marca avanza: el carril hizo su trabajo sobre esta rama.
      marcas.push({ suc: b.code, tablas, filas, error: null, ...(errTablas ? { nota: `${errTablas} tabla(s) con error` } : {}) });
    } catch (e) {
      // Falló ANTES de poder recorrer las tablas (ctl, listado): la rama no se revisó.
      marcas.push({ suc: b.code, tablas, filas, error: e.message.slice(0, 120) });
      fallas.push(`${b.code}: ${e.message.slice(0, 40)}`);
    } finally { await cerrar(p); }
  }
  return summary;
}

// ─── [NORM.3b] EJECUTAR SÓLO COMO SCRIPT ────────────────────────────────────────────────────
// Sin esta guarda el archivo no se puede `require` sin arrancar la ingesta entera, y por eso el
// candado de "destino nuevo" nació sin prueba negativa. Mismo patrón que `lib/cron-heartbeat.js`.
// Invocado como script (que es como lo invocan el cron y el compose) el comportamiento es idéntico.
if (require.main === module) {
  (async () => {
    console.log(`\n=== replicate-ods-LIVE — replicas locales → kepler_ods (${APPLY || WATCH_SEC ? 'APPLY' : 'DRY-RUN'}${FULL ? ', FULL' : ''}${WATCH_SEC ? `, WATCH ${WATCH_SEC}s` : ''}) ===`);
    console.log(`  sink: ${sink.sinkMode()}  ·  ramas: ${BRANCH_CODES.join(',')}  ·  tablas: ${ALL_MODE ? 'TODAS (espejo completo md.*)' : TABLES.length}`);
    console.log(ALL_MODE ? `  carril ctid (whitelist): ${[...CTID_TABLES].join(',')} · resto → hash` : `  carril hash: ${[...HASH_TABLES].join(',')}`);

    if (PRIME) {
      console.log(`  PRIME — fijando watermark ctid al máximo actual (sin shipear)…`);
      await primeCtid();
      console.log('PRIME hecho. Ahora corré --apply --watch para shipear solo lo nuevo (ctid) + catálogos.');
      return;
    }

    // Modo pg (on-prem/test): abre el cliente destino. DESTINO ≠ FUENTE — el default sale de
    // DATABASE_URL_NEW (la base de la app), no de ODS_SOURCE_BASE (el contenedor de replicas).
    // [NORM.3b] El sink HTTP también publica su identidad: si no, al volver a ese modo el candado
    // quedaría inerte y volveríamos al punto de partida (un cambio de destino invisible).
    if (sink.sinkMode() === 'http' && process.env.FEEDS_INGEST_URL) {
      try { const u = new URL(process.env.FEEDS_INGEST_URL); DEST_IDENT = `${u.host}${u.pathname}`; } catch { /* url inválida: queda null y se avisa */ }
    }
    if (sink.sinkMode() === 'pg') {
      const destStr = DEST_URL || process.env.DATABASE_URL_NEW || SUB_BASE;
      DEST = new Client({ connectionString: destStr, ssl: false, ...CONN });
      await DEST.connect();
    // ⛔⛔ [NORM.3c] LA ZONA HORARIA DE LA SESION DECIDE QUE FILA SE ESCRIBE.
    // El ODS guarda las columnas de fecha como `timestamptz` y la fuente las tiene como `timestamp`
    // INGENUO. Postgres interpreta ese valor ingenuo con la TZ DE LA SESION del que escribe: la
    // misma fila de origen shipeada desde una sesion en UTC y desde otra en hora de Mexico produce
    // DOS instantes distintos separados 6 h. Y en `kdpv_bitacora_precios` la PK incluye esa fecha
    // -> no se pisan, se DUPLICAN.
    // Medido en prod el 2026-09-24: 89,099 filas duplicadas a exactamente 6 h de su gemela, con
    // CERO pares asi en las replicas. La convencion mayoritaria (y la correcta, porque leida en
    // hora de Mexico coincide con el valor ingenuo del origen) es America/Mexico_City.
    // Se fija explicitamente y NO se hereda del contenedor: Alpine no trae tzdata, asi que `TZ` se
    // ignora en silencio y la sesion cae en UTC (la leccion de [VL.4]).
    await DEST.query("SET TIME ZONE 'America/Mexico_City'");
      // [NORM.3b] La identidad viaja SIN credenciales: host:puerto/base y nada más.
      DEST_IDENT = `${new URL(destStr).host}${new URL(destStr).pathname}`;
      console.log(`  destino pg: ${DEST_IDENT}`);
    }

    // Preflight del vigilante. En watch (desatendido, bajo supervisor) se ABORTA antes que correr a
    // ciegas: sin destino de latido, un carril muerto es indistinguible de uno sano y el tablero queda
    // verde — que es exactamente cómo se perdieron 6 días. En one-shot solo se avisa fuerte.
    // ⛔⛔ [DB-MEM.19] EL LATIDO NO DEPENDE DE CÓMO SE EMBARCAN LAS FILAS. Acá decía
    // `&& sink.sinkMode() === 'http'`, y eso tuvo sentido UN día: `[OBS.1]` (3375d0d7, 02-sep) lo
    // escribió cuando estos carriles shipeaban por http, así que atarlo al sink era equivalente a
    // "siempre". `[VL.11]` los pasó a escribir DIRECTO a `pg-prod` (`FEEDS_SINK=pg`) y con eso
    // APAGÓ EN SILENCIO el latido que OBS.1 acababa de instalar — sin tocar este archivo.
    //
    // Medido el 2026-09-23, y no es teórico: `ods_live_hot` llevaba 22.9 h sin escribir su renglón
    // (umbral 20 min), `health-lane.sh` lo leía vencido, y `autoheal` reinició los dos carriles
    // **39 veces en un día**, cada 5 minutos, para siempre. Nadie más escribe esa llave (verificado
    // por grep). Y el renglón viejo se queda con su `status='ok'`, así que el tablero no grita:
    // es EXACTAMENTE el falso verde que la Fase OBS existe para eliminar, reintroducido por la
    // mudanza. `latir()` abre su propio Client contra `ODS_HB_URL` (prod) — no toca el sink ni lo
    // necesita; ya se protege sola con `if (!HB_URL) return`.
    //
    // ⚠️ El one-shot exige llave EXPLÍCITA: `HB_KEY` cae por defecto a `ods_live_hot`/`ods_live_mirror`,
    // así que una corrida manual `--apply` sin `ODS_HB_KEY` pisaría el renglón del contenedor. Un
    // carril = UN dueño (ops/README §3.2). En `--watch` (los contenedores supervisados) es obligatorio.
    const late = WATCH_SEC > 0 || (APPLY && !!process.env.ODS_HB_KEY);
    if (late && !HB_URL) {
      const msg = 'falta ODS_HB_URL (destino del latido, = prod): sin ella db-health no puede vigilar este carril.';
      if (WATCH_SEC) { console.error(`✖ ${msg}\n  El ecosystem la pasa explícita. Abortando.`); process.exit(1); }
      console.warn(`⚠ ${msg}`);
    }
    // El latido NO debe viajar por el canal que vigila (GOTCHAS §18): si apunta al mismo lugar que la
    // FUENTE, no es prod y no sirve de nada.
    if (HB_URL && new URL(HB_URL).host === new URL(SUB_BASE).host) {
      console.error(`✖ ODS_HB_URL apunta a la FUENTE (${new URL(SUB_BASE).host}), no a prod — el latido sería invisible.`);
      if (WATCH_SEC) process.exit(1);
    }

    /** Un ciclo con latido: begin → cycleAll → end(ok|error). Reporta ENTREGA, no "el proceso corre". */
    const ciclarConLatido = async ({ full }) => {
      const t0 = Date.now();
      if (late) await latir('begin');
      try {
        const summary = await cycleAll({ apply: true, full });
        const wrote = summary.reduce((a, r) => a + (r.escritas || 0), 0);
        const errs = summary.filter((r) => r.error).length;
        const fallas = summary.fallas || [];
        // Una rama ilegible o una tabla en error es un ERROR del carril, aunque el proceso siga vivo.
        const malo = fallas.length > 0 || errs > 0;
        // [OBS.3.2] La marca por rama va ANTES del latido agregado: si el proceso muere entre las
        // dos, es preferible tener el detalle por sucursal y que falte el resumen que al revés.
        if (late) await marcarRamas(summary.marcas || []);
        if (late) {
          await latir('end', {
            status: malo ? 'error' : 'ok',
            rows: wrote,
            ms: Date.now() - t0,
            note: `${BRANCHES.length - fallas.length}/${BRANCHES.length} ramas · ${wrote} filas · ${errs} tablas con error`,
            error: malo
              ? [fallas.length ? `${fallas.length}/${BRANCHES.length} ramas no conectan — ${fallas.join(' · ')}` : null,
                errs ? `${errs} tablas con error` : null].filter(Boolean).join(' · ')
              : null,
          });
        }
        return { wrote, ms: Date.now() - t0 };
      } catch (e) {
        if (late) await latir('end', { status: 'error', ms: Date.now() - t0, error: e.message });
        throw e;
      }
    };

    if (!WATCH_SEC) {
      if (!APPLY) {
        const summary = await cycleAll({ apply: false, full: FULL });
        console.log('\n=== Resumen ===');
        console.table(summary.slice(0, 200));
        console.log('DRY-RUN — nada cambió. Corré con --apply.');
        if (DEST) await cerrar(DEST);
        return;
      }
      await ciclarConLatido({ full: FULL });
      console.log('APPLY hecho.');
      if (DEST) await cerrar(DEST);
      return;
    }

    console.log(`  watch activo (latido → ${HB_KEY}) — Ctrl+C para salir.`);
    let cycle = 0;
    for (;;) {
      cycle++;
      try {
        const { wrote, ms } = await ciclarConLatido({ full: FULL && cycle === 1 });
        if (wrote) console.log(`  ── ciclo ${cycle}: ${wrote} filas escritas (${ms}ms) ──`);
      } catch (e) {
        console.error(`  ✗ ciclo ${cycle}: ${e.message.slice(0, 120)}`);
      }
      await sleep(WATCH_SEC * 1000);
    }
  })().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
}

// Sólo para la prueba negativa de `database/tests/test-ods-dest-fingerprint.js`. No es API pública.
module.exports.__test = {
  ensureLocalCtl,
  DEST_CAMBIO,
  fijarDestIdent: (v) => { DEST_IDENT = v; },
  reiniciarAviso: () => { delete ensureLocalCtl._aviso; },
};
