#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[REP]` — Espejo PROD → LOCAL para desarrollo. Una sola dirección, prod SOLO LECTURA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UN ARCHIVO, UN PROCESO, SUBCOMANDOS.
 *
 * Esa frase está acá a propósito, porque es la restricción que va a estar bajo
 * presión la primera vez que alguien quiera "una sincronizacioncita más para X".
 * `database/importers/**` tiene 177 archivos y la REGLA PRINCIPAL del proyecto
 * es retirarlos, no sumarles el 178. Si hace falta traer otra cosa, se agrega
 * una FILA en `mirror.plan` (que se deriva del catálogo de prod), no un script.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ── La tensión con CLAUDE.md, dicha de frente ────────────────────────────────
 * "CERO importers" y "nunca copiar tablas" protegen EL NÚMERO PUBLICADO. Este
 * espejo no le publica nada al negocio: su consumidor es un dev y su salida es
 * un entorno. La excepción es real pero angosta, y tiene un solo modo de falla
 * que vale nombrar:
 *
 *     La regla se viola en el momento en que alguien lee un número del espejo
 *     y lo trata como número de negocio.
 *
 * Por eso el espejo declara su propia vejez (`mirror.pull_ctl`, veredicto
 * ternario) y va a colgarse del mismo `composeFreshness()` que ya usa la app,
 * para que un número del espejo llegue etiquetado `stale, hace 3 días` en vez
 * de llegar desnudo. Eso convierte una violación de regla en algo medido.
 *
 * ── Subcomandos ──────────────────────────────────────────────────────────────
 *   doctor       corre todos los frenos y NO TOCA NADA
 *   seed         restaura el respaldo nocturno + ANALYZE + refresca matviews
 *   refresh-mv   las matviews, una por una; la que falla se DECLARA
 *   migrate      drift + ledger fantasma + knex, de a UNA (como hace prod)
 *   grants       replica la MATRIZ de permisos de prod, no un GRANT ALL
 *   plan         (pendiente) deriva `mirror.plan` del catálogo de prod
 *   delta        (pendiente) los cuatro carriles
 *   reconcile    (pendiente) anti-join de PKs con --max-pct
 *   status       (pendiente) lee mirror.pull_ctl, veredicto ternario
 *
 * ── Variables ────────────────────────────────────────────────────────────────
 *   MIRROR_SOURCE_URL   origen. Si falta, cae a FLEET_DB_URL (ver nota abajo).
 *   MIRROR_TARGET_URL   destino. Sin default: un espejo sin destino declarado
 *                       no adivina dónde escribir.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');
const { Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const guard = require(path.resolve(__dirname, '../../libs/platform-core/src/lib/provenance/target-guard.js'));

const APP_NAME = 'mirror-pull';

// ─────────────────────────────────────────────────────────────────────────────
// CAPA G — ausencia de credencial.
//
// ⚠️ CORRECCIÓN AL PLAN. El plan decía "el env del espejo no tiene FLEET_DB_URL".
// Eso es imposible tal cual: FLEET_DB_URL *es* el handle de prod, o sea el
// ORIGEN que este script necesita leer. Prohibirla dejaría al espejo sin de
// dónde leer.
//
// Lo que sí hay que prohibir son las credenciales de ESCRITURA HACIA AFUERA: el
// latido, la llave del shipper, el espejo de feeds y la del ingest de tienda.
// Con esas ausentes, aunque el proceso tuviera un bug, no tiene con qué escribir
// en prod ni con qué pisar `analytics.cron_runs` — que es el daño real
// (`host` existe pero NO está en la PK `(tenant_id, job_key)`: un segundo
// escritor no crea otra fila, PISA la del primero, y el carril muerto pasa por
// sano reportando la máquina equivocada como dueña. GOTCHAS §35).
//
// La ausencia de una credencial con permiso de escritura es una garantía más
// fuerte que cualquier chequeo, pero el env está a un copy-paste de tenerla:
// por eso además se afirma.
// ─────────────────────────────────────────────────────────────────────────────
const CREDENCIALES_DE_ESCRITURA_HACIA_AFUERA = [
  'ODS_HB_URL',
  'FEEDS_INGEST_KEY',
  'FEEDS_MIRROR_URL',
  'STORE_INGEST_KEY',
];

/** Sentencias que este proceso puede mandarle a PROD. Todo lo demás se rechaza. */
const LECTURA = new RegExp(
  '^\\s*(' +
    'SELECT|WITH|SHOW|BEGIN|COMMIT|ROLLBACK|DECLARE|FETCH|CLOSE|EXPLAIN|' +
    'COPY\\s*\\(\\s*(SELECT|WITH)|' +           // COPY (SELECT …) TO STDOUT: sí
    'SET\\s+(LOCAL\\s+)?(TRANSACTION|SESSION|default_transaction_read_only|statement_timeout|application_name)' +
  ')\\b',
  'i',
);

/**
 * Abre PROD en modo lectura, con cuatro capas encima.
 *
 *   A  `options` en la conexión — la única que también cubre a `pg_dump`/`psql`
 *      (vía PGOPTIONS), que ninguna capa de código puede alcanzar.
 *   B  allowlist de forma de sentencia — frena nuestro propio bug, y se ve en
 *      code review.
 *   C  sonda VIVA (ver `assertProdIsReadOnly`) — frena que A no se haya aplicado.
 *   D  `SET SESSION CHARACTERISTICS` — cinturón sobre A, por si la URL perdió
 *      su `?options=`.
 */
async function openProdReadOnly(url) {
  const c = new Client({
    connectionString: url,
    application_name: APP_NAME,
    // CAPA A. Se pasa acá y no sólo en la URL, para que sobreviva a que alguien
    // reescriba la URL sin el `?options=`.
    options: '-c default_transaction_read_only=on -c idle_in_transaction_session_timeout=60000',
    // GOTCHAS §35: `pg` NO tiene timeout de conexión por default — sin esto un
    // connect() contra un host que no responde cuelga PARA SIEMPRE.
    connectionTimeoutMillis: 20000,
    statement_timeout: 1800000,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();

  // CAPA D.
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

  // CAPA B — se envuelve `query` DESPUÉS de los SET de arriba.
  const crudo = c.query.bind(c);
  // La sonda de la capa C necesita mandar una escritura A PROPÓSITO para
  // comprobar que el motor la rechaza. Es el ÚNICO bypass autorizado de la
  // capa B, y por eso lleva nombre feo: si aparece en otro lado, se ve.
  c.__queryCrudaSoloParaLaSonda = crudo;
  c.query = (texto, ...resto) => {
    const sql = typeof texto === 'string' ? texto : texto && texto.text;
    if (typeof sql === 'string' && !LECTURA.test(sql)) {
      const primeras = sql.trim().slice(0, 60).replace(/\s+/g, ' ');
      throw new Error(
        `ABORT: este proceso sólo LEE de prod y esta sentencia no parece lectura → "${primeras}…"`,
      );
    }
    return crudo(texto, ...resto);
  };
  return c;
}

/**
 * CAPA C — prueba VIVA de que la sesión no puede escribir.
 *
 * `SHOW transaction_read_only` dice lo que la sesión CREE. Esto lo comprueba
 * mandando escrituras de verdad y exigiendo que el MOTOR las rechace con 25006.
 *
 * ── Las tres candidatas, medidas contra prod (PG 18.6) el 2026-09-08 ─────────
 *
 *   pg_current_xact_id()   PASA. Devuelve un XID nuevo (10612378) sin levantar
 *                          nada. Lo mismo `txid_current()`. Es la sonda que el
 *                          diseño traía y NO SIRVE: habría dado verde siempre.
 *                          No la vuelvas a poner.
 *   CREATE TEMP TABLE      rechazado 25006. El diseño la descartaba diciendo
 *                          que las escrituras temporales están permitidas en
 *                          una transacción read-only — no lo están.
 *   UPDATE de 0 filas      rechazado 25006. La que además cumple GOTCHAS §33:
 *                          un SELECT que funciona no prueba que un UPDATE
 *                          funcione. Ahí un rol "de solo lectura" tumbó prod
 *                          porque el login SÍ escribía.
 *
 * Se usan las DOS que sirven, y las dos tienen que ser rechazadas:
 *   - la temp no depende de que exista ninguna tabla (sirve en cualquier base),
 *   - el UPDATE es la forma exacta del daño que estamos previniendo.
 *
 * El UPDATE va con `WHERE false` sobre una tabla que existe. Si la tabla no
 * existiera (42P01) la sonda no midió nada, y eso se DECLARA — no se cuenta
 * como aprobada (ADR-056: lo que no se pudo medir se declara, no se dibuja).
 */
const TABLA_SONDA = 'analytics.cron_runs';

async function assertProdIsReadOnly(prod) {
  const crudo = prod.__queryCrudaSoloParaLaSonda;
  const r = { temp: null, update: null };

  try {
    await crudo('CREATE TEMP TABLE _mirror_sonda_readonly (x int)');
    throw new Error('ABORT: PROD aceptó un CREATE TEMP TABLE. La sesión NO es de solo lectura.');
  } catch (e) {
    if (e.code === '25006') r.temp = 'rechazado';
    else if (/ABORT:/.test(e.message)) throw e;
    else throw e;
  }

  try {
    await crudo(`UPDATE ${TABLA_SONDA} SET tenant_id = tenant_id WHERE false`);
    throw new Error(`ABORT: PROD aceptó un UPDATE sobre ${TABLA_SONDA}. La sesión NO es de solo lectura.`);
  } catch (e) {
    if (e.code === '25006') r.update = 'rechazado';
    else if (e.code === '42P01') r.update = 'no_medido';   // la tabla sonda no existe acá
    else if (/ABORT:/.test(e.message)) throw e;
    else throw e;
  }

  return r;
}

function resolverUrls() {
  const source = process.env.MIRROR_SOURCE_URL || process.env.FLEET_DB_URL || null;
  const target = process.env.MIRROR_TARGET_URL || null;
  return { source, target };
}

// ─────────────────────────────────────────────────────────────────────────────
// doctor
// ─────────────────────────────────────────────────────────────────────────────
async function doctor() {
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg, extra ? `\n      ${extra}` : ''); }
    return cond;
  };

  console.log('\nEspejo PROD → LOCAL · doctor (no toca nada)\n');

  // ── G ──
  const presentes = CREDENCIALES_DE_ESCRITURA_HACIA_AFUERA.filter((v) => process.env[v]);
  ok(
    presentes.length === 0,
    `G · sin credenciales de escritura hacia afuera (${CREDENCIALES_DE_ESCRITURA_HACIA_AFUERA.join(', ')})`,
    presentes.length ? `presentes: ${presentes.join(', ')} — el espejo no late a prod ni shipea nada. Quitalas del env de esta tarea.` : '',
  );

  // ── destinos ──
  const { source, target } = resolverUrls();
  if (!ok(Boolean(source), 'origen declarado (MIRROR_SOURCE_URL o FLEET_DB_URL)')) return salir(pass, fail);
  if (!ok(Boolean(target), 'destino declarado (MIRROR_TARGET_URL)',
    'sin destino no adivino dónde escribir. Declaralo aunque sea para el doctor.')) return salir(pass, fail);

  // La guarda aborta el proceso si algo no cuadra, así que llegar vivo ES el ✓.
  guard.assertTarget('pull-prod-to-local[origen]', { url: source, intent: 'read', expect: 'prod' });
  ok(true, 'origen clasifica como PROD');

  // El destino se valida con `assertSafeTarget`, NO con `assertTarget(expect:'local')`.
  //
  // Lo primero que se escribió acá fue `expect:'local'`, y la primera corrida contra
  // el destino real lo rechazó: la réplica vive en `.245`, que la guarda clasifica
  // como `compartida` — correctamente, porque esa caja la ven los tres devs.
  //
  // La política del destino de un espejo no es "tiene que ser mi localhost", es
  // **"no puede ser prod, y tengo que reconocerlo"**. `assertSafeTarget` ya expresa
  // exactamente eso: aborta en `prod` y en `desconocido` (fail-closed), y deja pasar
  // la compartida AVISANDO en cada corrida. Reusarla es preferible a duplicar acá una
  // segunda política de destino que después se desincroniza de la del suite.
  const destino = guard.assertSafeTarget('pull-prod-to-local[destino]', { url: target });
  ok(true, `destino reconocido y no es prod (${destino.kind})`);

  guard.assertDistinct('pull-prod-to-local', source, target);
  ok(true, 'origen y destino son bases distintas (host:port/db)');

  // ── A + C + D, contra prod de verdad ──
  let prod;
  try {
    prod = await openProdReadOnly(source);
  } catch (e) {
    ok(false, 'A/D · abre la conexión a prod en modo lectura', e.message.slice(0, 120));
    return salir(pass, fail);
  }
  try {
    const ro = (await prod.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    ok(ro === 'on', `A · la sesión se declara read-only (transaction_read_only=${ro})`);

    const sonda = await assertProdIsReadOnly(prod);
    ok(sonda.temp === 'rechazado', 'C · sonda viva: el motor rechaza CREATE TEMP TABLE con 25006');
    if (sonda.update === 'no_medido') {
      // Ni ✓ ni ✗: NO MEDIDO. La tabla sonda no existe en este destino, así que
      // la sonda no comprobó nada — y un "no pude medir" no se cuenta como pasó.
      console.log(`  ⓘ C · UPDATE sobre ${TABLA_SONDA}: NO MEDIDO (la tabla no existe acá)`);
    } else {
      ok(sonda.update === 'rechazado', `C · sonda viva: el motor rechaza un UPDATE sobre ${TABLA_SONDA} con 25006`);
    }

    // B — la allowlist tiene que rechazar una escritura. Prueba negativa inline:
    // si esto NO tira, la capa B está desarmada y hay que saberlo acá, no después.
    let rechazo = false;
    try {
      await prod.query("UPDATE analytics.cron_runs SET note = note WHERE job_key = '__mirror_probe_never_exists__'");
    } catch (e) {
      rechazo = /sólo LEE de prod/.test(e.message);
    }
    ok(rechazo, 'B · la allowlist rechaza un UPDATE antes de mandarlo al cable');

    // Y que sí deje pasar lo que tiene que dejar pasar.
    let copyOk = true;
    try {
      await prod.query('SELECT 1');
      LECTURA.test('COPY (SELECT 1) TO STDOUT') || (copyOk = false);
    } catch { copyOk = false; }
    ok(copyOk, 'B · deja pasar SELECT y COPY (SELECT …) TO STDOUT');

    const v = (await prod.query('SELECT current_database() db, split_part(version(), \' \', 2) v')).rows[0];
    console.log(`      prod: ${v.db} · PostgreSQL ${v.v}`);
  } finally {
    try { await prod.end(); } catch { /* nada */ }
  }

  return salir(pass, fail);
}

function salir(pass, fail) {
  console.log(`\nREP doctor: ${pass} OK, ${fail} fallidos\n`);
  process.exit(fail ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// seed — la siembra
//
// ⚠️ NO dumpea prod. Restaura el RESPALDO NOCTURNO que ya existe.
//
// El plan original decía "pg_dump de prod partido en dos pases, core y bulk".
// Dos mediciones lo tiraron abajo:
//
//  1. **El grafo de dependencias es circular entre los dos pases.** Medido sobre
//     prod: `md` (225 vistas) y `catalog.products_active` dependen de
//     `kepler_ods`; pero `analytics` (43 vistas) depende de `commercial`,
//     `catalog`, `finance` y `logistics`, y `wincaja` (4 vistas) de `catalog`.
//     Cualquier split por schema con `--exit-on-error` revienta en las dos
//     direcciones. Un solo dump resuelve el orden solo, porque pg_dump ordena.
//
//  2. **El respaldo nocturno ya dumpea prod entero, todos los días.** Desde
//     REP.0.0 produce un `-Fc` completo (601 tablas, ~2 GB, 68 min). Volver a
//     dumpear prod para el espejo sería pagar dos veces el mismo snapshot largo
//     sobre la misma base — y el snapshot es justo lo que hay que cuidar,
//     porque fija el horizonte de xid y le frena el vacuum a prod.
//
// Así que el espejo se cuelga del respaldo: **prod se lee una vez por día, para
// respaldar, y el espejo reusa esa misma foto.** Carga adicional sobre prod:
// cero. Y de yapa, el respaldo pasa a tener un consumidor que lo ejercita todos
// los días — un respaldo que nadie restaura nunca es una hipótesis.
// ─────────────────────────────────────────────────────────────────────────────

const BACKUP_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '.', 'backups', 'trade_marketing');

/** El `.dump` más reciente del directorio de respaldos. */
function dumpMasReciente(dir) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir)
    .filter((n) => n.endsWith('.dump'))
    .map((n) => ({ n, p: path.join(dir, n), t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  return f || null;
}

function binPg(nombre) {
  const cands = [
    `C:\\Program Files\\PostgreSQL\\18\\bin\\${nombre}.exe`,
    `C:\\Program Files\\PostgreSQL\\17\\bin\\${nombre}.exe`,
  ];
  const hit = cands.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`No encuentro ${nombre}. Instalá las client tools de PostgreSQL 18.`);
  return hit;
}

/** Parte la URL en args sueltos: la credencial va por PGPASSWORD, no en la línea de comandos. */
function partirUrl(url) {
  const u = new URL(url);
  return {
    args: ['--host', u.hostname, '--port', u.port || '5432',
      '--username', decodeURIComponent(u.username), '--dbname', decodeURIComponent(u.pathname).replace(/^\//, '')],
    env: { PGPASSWORD: decodeURIComponent(u.password || '') },
    donde: `${u.hostname}/${decodeURIComponent(u.pathname).replace(/^\//, '')}`,
  };
}

async function seed(opts) {
  const { target } = resolverUrls();
  if (!target) { console.error('\nFalta MIRROR_TARGET_URL.\n'); process.exit(2); }
  guard.assertSafeTarget('seed[destino]', { url: target });

  const dump = opts.fromDump
    ? { p: path.resolve(opts.fromDump), n: path.basename(opts.fromDump) }
    : dumpMasReciente(BACKUP_DIR);
  if (!dump || !fs.existsSync(dump.p)) {
    console.error(`\nNo hay respaldo que restaurar en ${BACKUP_DIR}.`);
    console.error('Corré primero: powershell -File scripts\\backup-db.ps1\n');
    process.exit(2);
  }
  const st = fs.statSync(dump.p);
  const horas = ((Date.now() - st.mtimeMs) / 3600000).toFixed(1);
  console.log(`\nSiembra desde respaldo\n  archivo : ${dump.n}`);
  console.log(`  tamaño  : ${(st.size / 1048576).toFixed(0)} MB`);
  console.log(`  edad    : ${horas} h`);

  const pgRestore = binPg('pg_restore');

  // 1. El TOC, filtrado. Se sacan las 10 `MATERIALIZED VIEW DATA`: si el REFRESH
  //    corre DENTRO de pg_restore va serializado y, si uno falla, `--exit-on-error`
  //    tira abajo una restauración de una hora. Refrescándolas aparte se reporta
  //    una por una y un fallo no cuesta el trabajo entero.
  const toc = execFileSync(pgRestore, ['-l', dump.p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lineas = toc.split(/\r?\n/);
  const fuera = lineas.filter((l) => /MATERIALIZED VIEW DATA/.test(l));
  const lista = lineas.filter((l) => !/MATERIALIZED VIEW DATA/.test(l)).join('\n');
  const listFile = path.join(os.tmpdir(), `mirror-toc-${Date.now()}.list`);
  fs.writeFileSync(listFile, lista);
  console.log(`  TOC     : ${lineas.filter((l) => /^\d+;/.test(l)).length} entradas, ${fuera.length} matviews apartadas para refrescar aparte`);

  // 2. Restaurar. `--exit-on-error` a propósito: reemplaza el `|| true` de
  //    sync-from-remote.js, que se traga el resultado entero del restore.
  const t = partirUrl(target);
  console.log(`  destino : ${t.donde}\n\nrestaurando (esto tarda; --jobs=${opts.jobs})…`);
  const t0 = Date.now();
  const r = spawnSync(pgRestore, [
    ...t.args, '--jobs', String(opts.jobs), '--exit-on-error',
    '--no-owner', '--no-privileges', '--use-list', listFile, dump.p,
  ], { encoding: 'utf8', env: { ...process.env, ...t.env }, maxBuffer: 256 * 1024 * 1024 });

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  try { fs.unlinkSync(listFile); } catch { /* nada */ }

  if (r.status !== 0) {
    console.error(`\nFALLÓ el restore (exit ${r.status}) después de ${mins} min.`);
    console.error((r.stderr || '').split(/\r?\n/).slice(0, 25).join('\n'));
    process.exit(1);
  }
  console.log(`\nrestore OK en ${mins} min.`);
  if (r.stderr && r.stderr.trim()) {
    const w = r.stderr.split(/\r?\n/).filter(Boolean);
    console.log(`  (${w.length} líneas en stderr; las primeras 5)`);
    w.slice(0, 5).forEach((l) => console.log('   ', l.slice(0, 150)));
  }

  // 3. ANALYZE. `pg_restore` NO lo corre, y sin estadísticas el planner improvisa.
  //    Medido tras la primera siembra: **281 tablas sin una sola fila en pg_stats**.
  //    No es sólo lentitud — una réplica sin estadísticas da planes distintos a los
  //    de prod, así que cualquier trabajo de performance hecho encima mide otra cosa.
  console.log('\nANALYZE (pg_restore no lo corre; sin esto el planner improvisa)…');
  const ta = Date.now();
  const an = new Client({ connectionString: target, connectionTimeoutMillis: 20000, statement_timeout: 0 });
  await an.connect();
  await an.query('ANALYZE');
  const sin = Number((await an.query(`select count(*)::int n from pg_class c
     join pg_namespace n on n.oid=c.relnamespace
     left join pg_stats s on s.schemaname=n.nspname and s.tablename=c.relname
    where c.relkind='r' and n.nspname not in ('pg_catalog','information_schema') and s.tablename is null`)).rows[0].n);
  await an.end();
  console.log(`  ANALYZE en ${((Date.now() - ta) / 60000).toFixed(1)} min · tablas sin estadísticas: ${sin} (las vacías no tienen, y está bien)`);

  // 4. Las matviews, ACÁ y no después.
  //
  //    Primera corrida: se dejaron para "más tarde" y la migración
  //    `20260909170000_sellout_dedup_madero_07.js` falló con
  //    «la vista materializada mv_kepler_sales_daily no ha sido poblada».
  //    Las migraciones LEEN matviews, así que refrescarlas es parte de la siembra,
  //    no un paso opcional que uno se acuerda de correr.
  await refreshMatviews(target);

  console.log('\nSigue: `migrate` (drift + ledger fantasma) y después `grants`.');
}

// ─────────────────────────────────────────────────────────────────────────────
// refresh-mv — las matviews que `seed` apartó del TOC
//
// `pg_dump` NUNCA copia el contenido de una matview: emite el CREATE y una
// entrada `MATERIALIZED VIEW DATA` que corre un REFRESH al restaurar. `seed` la
// saca del TOC porque dentro de `pg_restore` va serializada y, si una falla,
// `--exit-on-error` tira abajo una restauración de una hora.
//
// Acá se refrescan una por una, con su tiempo, y **una que falla se declara**
// en vez de dejar la matview VÁLIDA Y VACÍA — que es el peor resultado posible,
// porque vacío se lee igual que "no hay datos" (GOTCHAS §32).
//
// El orden se resuelve solo: se reintenta mientras haya progreso. Una matview
// que depende de otra falla en la primera vuelta y sale en la segunda; si dos
// vueltas seguidas no arreglan nada, lo que queda se reporta.
// ─────────────────────────────────────────────────────────────────────────────
async function refreshMatviews(target) {
  const c = new Client({ connectionString: target, connectionTimeoutMillis: 20000, statement_timeout: 0 });
  await c.connect();
  let pend = (await c.query(`select n.nspname||'.'||c.relname mv, c.relispopulated pob
     from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='m' order by 1`)).rows;
  console.log(`\nmatviews: ${pend.length} (${pend.filter((r) => r.pob).length} ya pobladas)`);
  pend = pend.filter((r) => !r.pob).map((r) => r.mv);

  const hechas = []; const fallidas = [];
  let vuelta = 0;
  while (pend.length && vuelta < 4) {
    vuelta++;
    const quedan = [];
    for (const mv of pend) {
      const t0 = Date.now();
      try {
        await c.query(`REFRESH MATERIALIZED VIEW ${mv}`);
        const s = ((Date.now() - t0) / 1000).toFixed(1);
        const n = Number((await c.query(`select count(*)::bigint n from ${mv}`)).rows[0].n);
        console.log(`  ✓ ${mv.padEnd(42)} ${s}s  ${n.toLocaleString('es-MX')} filas`);
        hechas.push(mv);
      } catch (e) {
        quedan.push(mv);
        if (vuelta >= 2) fallidas.push({ mv, err: `${e.code} ${e.message.slice(0, 90)}` });
      }
    }
    if (quedan.length === pend.length) break;   // sin progreso: no es un tema de orden
    pend = quedan;
  }
  for (const f of [...new Map(fallidas.map((x) => [x.mv, x])).values()]) {
    if (!hechas.includes(f.mv)) console.log(`  ✗ ${f.mv} — ${f.err}`);
  }
  const rotas = pend.filter((mv) => !hechas.includes(mv));
  console.log(`\n  refrescadas: ${hechas.length} · sin poblar: ${rotas.length}`);
  if (rotas.length) {
    console.log('  ⚠ Estas quedan VÁLIDAS Y VACÍAS. Vacío se lee igual que "no hay datos":');
    rotas.forEach((mv) => console.log(`     · ${mv}`));
  }
  await c.end();
  return { hechas: hechas.length, rotas };
}

// ─────────────────────────────────────────────────────────────────────────────
// migrate — el drift, el ledger fantasma, y recién después knex
//
// El dump trae el ledger de PROD (619 filas al medirlo), y el disco tiene 636
// archivos. Correr `migrate:latest` a ciegas contra eso tiene tres formas de
// salir mal, y las tres ya pasaron en este repo:
//
//   §29  Hay DOS ledgers. `identity.knex_migrations` existe además de
//        `public.knex_migrations`, e `identity` va ANTES que `public` en el
//        search_path — así que un runner sin `schemaName` lee y ESCRIBE el
//        equivocado. En prod llegó a tener 4 filas, una de ellas una migración
//        cuyo `up()` arranca con DROP MATERIALIZED VIEW ... CASCADE.
//   §3   Una fila del ledger cuyo archivo no está en tu rama hace que knex
//        aborte entero con "the migration directory is corrupt".
//        `disableMigrationsListValidation` lo destraba, pero entonces las
//        huérfanas se vuelven invisibles: se listan por nombre.
//   VP.1 "La migración corrió" no es "el objeto existe".
//
// Y un cuarto, gratis: con el ledger de prod acá, el espejo es el detector de
// fantasmas más barato que hay — lee los dos ledgers de prod todas las noches
// sin costo. Si el fantasma CRECIÓ, hay un runner mal configurado en prod ahora
// mismo, y eso se reporta como HALLAZGO, no como un arreglo local.
// ─────────────────────────────────────────────────────────────────────────────
const DIR_MIG = path.resolve(__dirname, '../migrations-newdb');

async function migrate(opts) {
  const { target } = resolverUrls();
  if (!target) { console.error('\nFalta MIRROR_TARGET_URL.\n'); process.exit(2); }
  guard.assertSafeTarget('migrate[destino]', { url: target });

  const c = new Client({ connectionString: target, connectionTimeoutMillis: 20000 });
  await c.connect();

  const enDisco = fs.readdirSync(DIR_MIG).filter((f) => f.endsWith('.js'));
  const aplicadas = (await c.query('select name from public.knex_migrations order by name')).rows.map((r) => r.name);
  const setDisco = new Set(enDisco);
  const setApl = new Set(aplicadas);
  const pendientes = enDisco.filter((f) => !setApl.has(f)).sort();
  const huerfanas = aplicadas.filter((n) => !setDisco.has(n));

  // El fantasma. Se DETECTA siempre, se repara sólo local.
  //
  // Se distinguen DOS estados que no son lo mismo, y colapsarlos sería el mismo
  // error que esta fase persigue en otros lados: "la tabla no existe" (el
  // detector no aplica) vs "existe y no tiene filas huérfanas" (el detector
  // aplicó y salió limpio). Un "0" a secas se lee como lo segundo cuando puede
  // ser lo primero.
  let fantasma = [];
  let fantasmaTabla = null;   // null = no existe · number = filas totales
  try {
    fantasmaTabla = Number((await c.query('select count(*)::int n from identity.knex_migrations')).rows[0].n);
    fantasma = (await c.query(`select i.name, i.batch, i.migration_time from identity.knex_migrations i
       where not exists (select 1 from public.knex_migrations p where p.name = i.name)
       order by i.migration_time`)).rows;
  } catch (e) {
    if (e.code !== '42P01') throw e;   // 42P01 = no existe la tabla
  }

  console.log('\nDrift de migraciones');
  console.log(`  ledger restaurado de prod : ${aplicadas.length}`);
  console.log(`  archivos en disco         : ${enDisco.length}`);
  console.log(`  pendientes                : ${pendientes.length}`);
  console.log(`  huérfanas (ledger sin archivo en esta rama): ${huerfanas.length}`);
  huerfanas.forEach((n) => console.log(`     · ${n}`));
  console.log(fantasmaTabla === null
    ? '  fantasma identity.knex_migrations: la tabla NO EXISTE (§29 cerrado por 20260907160000)'
    : `  fantasma identity.knex_migrations: la tabla existe con ${fantasmaTabla} filas, ${fantasma.length} sin correlato en public`);
  fantasma.forEach((f) => console.log(`     · ${f.name} (batch ${f.batch})`));
  if (fantasma.length > 4) {
    console.log('  ⚠ HALLAZGO EN PROD: el fantasma creció por encima de las 4 filas medidas el 2026-09-07.');
    console.log('    Hay un runner sin `migrations.schemaName` escribiendo en prod AHORA.');
  }

  if (opts.expectPending !== null && pendientes.length !== opts.expectPending) {
    console.error(`\nABORT: esperaba ${opts.expectPending} pendientes y hay ${pendientes.length}.`);
    console.error('  `migrate:latest` corre las pendientes de TODOS. Que el número salte significa');
    console.error('  que hay una rama ajena en tu working tree, y querés verlo ANTES de que corra.');
    pendientes.forEach((n) => console.error(`     · ${n}`));
    await c.end();
    process.exit(2);
  }

  if (!opts.apply) {
    console.log('\n(dry-run) Las que correrían:');
    pendientes.forEach((n) => console.log(`   · ${n}`));
    console.log('\nPara aplicarlas: --apply');
    await c.end();
    return;
  }

  // Reparar el fantasma SÓLO acá. Nunca `DELETE FROM identity.knex_migrations`:
  // la tabla es el sensor de su propia causa y borrarla es apagar el detector.
  if (fantasma.length) {
    await c.query(`insert into public.knex_migrations (name, batch, migration_time)
      select i.name, (select coalesce(max(batch),0)+1 from public.knex_migrations), i.migration_time
        from identity.knex_migrations i
       where not exists (select 1 from public.knex_migrations p where p.name = i.name)`);
    console.log(`\n  ${fantasma.length} del fantasma re-registradas en public (local; el fantasma NO se borra)`);
  }
  await c.end();

  const knex = require('knex')({
    client: 'pg',
    connection: { connectionString: target },
    pool: { min: 1, max: 4 },
    migrations: {
      directory: DIR_MIG,
      tableName: 'knex_migrations',
      // Sin esto el ledger cae en `identity` (§29).
      schemaName: 'public',
      // El ledger de prod registra migraciones que esta rama no tiene en disco;
      // sin esta bandera knex aborta entero. Las huérfanas ya se listaron arriba.
      disableMigrationsListValidation: true,
    },
  });
  // UNA POR UNA con `migrate.up()`, no `migrate.latest()`.
  //
  // Knex envuelve **el lote entero en UNA transacción**, así que si la última de
  // 14 falla, se revierten las 14. Pasó acá: `20260909170000_sellout_dedup_madero_07`
  // falló por una matview sin poblar y el ledger se quedó donde estaba, después
  // de media hora de trabajo.
  //
  // Y hay un precedente que lo zanja: **prod las aplica de a una**. Medido en su
  // ledger, cada migración tiene su propio batch (338, 339, … 353), porque se
  // corren con `apply-one-migration-prod.js`. Acá se hace igual: una lenta no
  // arrastra a las otras, cada transacción es corta, y lo que entra queda.
  const t0 = Date.now();
  const hechas = []; let fallo = null;
  try {
    console.log(`\naplicando ${pendientes.length}, de a UNA (como hace prod)…`);
    for (;;) {
      const antes = Date.now();
      let corridas;
      try {
        [, corridas] = await knex.migrate.up();
      } catch (e) {
        fallo = e;
        break;
      }
      if (!corridas || !corridas.length) break;
      const seg = ((Date.now() - antes) / 1000).toFixed(1);
      const nombre = path.basename(corridas[0].file || corridas[0]);
      console.log(`  ✓ ${String(seg).padStart(7)}s  ${nombre}`);
      hechas.push(nombre);
    }
  } finally {
    const quedan = (await knex.migrate.list().catch(() => [[], []]))[1] || [];
    console.log(`\n  aplicadas: ${hechas.length} en ${((Date.now() - t0) / 60000).toFixed(1)} min · pendientes: ${quedan.length}`);
    if (fallo) {
      console.log(`  ✗ se detuvo en la siguiente: ${String(fallo.message).slice(0, 160)}`);
      console.log('    Las anteriores QUEDARON aplicadas (por eso de a una y no en lote).');
    }
    quedan.forEach((n) => console.log('     pendiente ·', path.basename(n.file || n)));
    await knex.destroy();
    if (fallo) process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// grants — replicar la MATRIZ DE PERMISOS de prod, no otorgar parejo
//
// `pg_dump --no-privileges` no trae ningún GRANT, así que después del restore
// `app_runtime` no puede leer nada. La tentación es un GRANT ALL sobre todo,
// que es lo que hace `sync-from-remote.js` (y encima sólo sobre 4 schemas).
//
// **Otorgar parejo rompe el motivo de usar `app_runtime`.** Medido en prod, la
// matriz NO es uniforme:
//
//     kepler_ods   226 SELECT,   0 INSERT,   0 DELETE   ← lo alimenta el shipper
//     md           225 SELECT,   0 INSERT,   0 DELETE   ← vistas sobre el ODS
//     analytics    117 SELECT,  24 INSERT,  13 DELETE
//     commercial   115 SELECT, 115 INSERT, 115 DELETE
//     pgboss         0 SELECT — ni USAGE en el schema (la cola corre como postgres)
//     identity      13 relaciones y sólo 11 legibles
//
// Con un GRANT ALL, un dev escribe un INSERT a `kepler_ods`, le funciona en la
// réplica y le explota en prod. La réplica tiene que MENTIR lo menos posible, y
// los permisos son parte de lo que replica.
//
// Se lee la matriz de prod (solo lectura) y se aplica igual acá.
// ─────────────────────────────────────────────────────────────────────────────
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const ROL = 'app_runtime';

async function grants() {
  const { source, target } = resolverUrls();
  if (!source || !target) { console.error('\nFaltan MIRROR_SOURCE_URL/MIRROR_TARGET_URL.\n'); process.exit(2); }
  guard.assertTarget('grants[origen]', { url: source, intent: 'read', expect: 'prod' });
  guard.assertSafeTarget('grants[destino]', { url: target });

  const prod = await openProdReadOnly(source);
  const rep = new Client({ connectionString: target, connectionTimeoutMillis: 20000 });
  await rep.connect();

  let aplicados = 0;
  const q = async (sql) => { await rep.query(sql); aplicados++; };

  // 1. USAGE de schema, tal cual prod (pgboss NO lo tiene, y así queda).
  const sch = await prod.query(`select n.nspname s, has_schema_privilege($1, n.nspname,'USAGE') u
     from pg_namespace n where n.nspname not in ('pg_catalog','information_schema','pg_toast')
       and n.nspname not like 'pg\\_temp%' and n.nspname not like 'pg\\_toast%' order by 1`, [ROL]);
  const conUsage = sch.rows.filter((r) => r.u).map((r) => r.s);
  for (const s of conUsage) {
    try { await q(`GRANT USAGE ON SCHEMA "${s}" TO ${ROL}`); } catch { /* el schema puede no existir acá */ }
  }
  console.log(`  USAGE de schema: ${conUsage.length} otorgados · sin USAGE en prod (y tampoco acá): ${sch.rows.filter((r) => !r.u).map((r) => r.s).join(', ') || 'ninguno'}`);

  // 2. Privilegios por relación, agrupados por conjunto idéntico para no emitir
  //    una sentencia por tabla (serían ~900).
  const rel = await prod.query(`
    select n.nspname s, c.relname t,
           ${PRIVS.map((p) => `has_table_privilege($1, c.oid, '${p}') as "${p.toLowerCase()}"`).join(', ')}
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where c.relkind in ('r','p','v','m')
       and n.nspname not in ('pg_catalog','information_schema','pg_toast')
       and n.nspname not like 'pg\\_temp%' and n.nspname not like 'pg\\_toast%'`, [ROL]);

  const grupos = new Map();
  for (const r of rel.rows) {
    const set = PRIVS.filter((p) => r[p.toLowerCase()]);
    if (!set.length) continue;
    const k = `${r.s}|${set.join(',')}`;
    if (!grupos.has(k)) grupos.set(k, { s: r.s, set, tablas: [] });
    grupos.get(k).tablas.push(r.t);
  }
  let conPriv = 0;
  for (const g of grupos.values()) {
    // En lotes: una sentencia con 226 nombres es válida pero ilegible en un error.
    for (let i = 0; i < g.tablas.length; i += 50) {
      const lote = g.tablas.slice(i, i + 50).map((t) => `"${g.s}"."${t}"`).join(', ');
      try { await q(`GRANT ${g.set.join(', ')} ON ${lote} TO ${ROL}`); conPriv += Math.min(50, g.tablas.length - i); }
      catch (e) { console.log(`  ! ${g.s} [${g.set.join(',')}]: ${e.code} ${e.message.slice(0, 80)}`); }
    }
  }
  console.log(`  privilegios de tabla: ${conPriv} relaciones en ${grupos.size} combinaciones distintas`);
  for (const g of [...grupos.values()].sort((a, b) => b.tablas.length - a.tablas.length).slice(0, 6)) {
    console.log(`     ${String(g.s).padEnd(14)} ${String(g.tablas.length).padStart(4)} rels  ${g.set.join(',')}`);
  }

  // 3. Secuencias y funciones.
  for (const s of conUsage) {
    try { await q(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${s}" TO ${ROL}`); } catch { /* nada */ }
    try { await q(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${s}" TO ${ROL}`); } catch { /* nada */ }
  }

  // 4. Los default ACL, para que lo que se cree DESPUÉS herede igual que en prod.
  const dacl = await prod.query(`select n.nspname s, da.defaclobjtype tipo, array_to_string(da.defaclacl,',') acl
     from pg_default_acl da join pg_namespace n on n.oid=da.defaclnamespace`);
  const MAPA = { r: 'TABLES', S: 'SEQUENCES', f: 'FUNCTIONS', T: 'TYPES' };
  const LETRA = { a: 'INSERT', r: 'SELECT', w: 'UPDATE', d: 'DELETE', D: 'TRUNCATE', x: 'REFERENCES', t: 'TRIGGER', X: 'EXECUTE', U: 'USAGE' };
  for (const d of dacl.rows) {
    const m = (d.acl || '').match(new RegExp(`${ROL}=([^/]*)/`));
    if (!m || !MAPA[d.tipo]) continue;
    const privs = [...new Set(m[1].split('').map((ch) => LETRA[ch]).filter(Boolean))];
    if (!privs.length) continue;
    try { await q(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${d.s}" GRANT ${privs.join(', ')} ON ${MAPA[d.tipo]} TO ${ROL}`); }
    catch (e) { console.log(`  ! default acl ${d.s}/${MAPA[d.tipo]}: ${e.code}`); }
  }
  console.log(`  default privileges: ${dacl.rows.length} entradas replicadas`);
  console.log(`  ${aplicados} sentencias aplicadas`);

  await prod.end();
  await rep.end();

  // 5. Verificar. Y no con un SELECT: GOTCHAS §33 existe porque un rol "de solo
  //    lectura" pasó todos los SELECT y tumbó prod en el primer UPDATE real.
  await verificarComoRuntime(target);
}

/** Se conecta COMO app_runtime y comprueba lo que puede y —sobre todo— lo que NO. */
async function verificarComoRuntime(target) {
  // Con qué credencial verificar, en orden. Medido en `.245`: **`platform_runtime`
  // es MIEMBRO de `app_runtime`**, así que hereda todos los grants de arriba y
  // sirve igual para comprobarlos — y su contraseña sí está en el `.env`, mientras
  // que la de `app_runtime` en esa caja no (el default `app_runtime` da 28P01).
  // Los dos son NOBYPASSRLS, así que la RLS se ejercita con cualquiera de los dos.
  const candidatos = [];
  if (process.env.APP_RUNTIME_PASSWORD) {
    const u = new URL(target); u.username = ROL; u.password = process.env.APP_RUNTIME_PASSWORD;
    candidatos.push({ rol: ROL, url: u.toString() });
  }
  { const u = new URL(target); u.username = ROL; u.password = ROL;
    candidatos.push({ rol: ROL + ' (contraseña por default)', url: u.toString() }); }
  if (process.env.DATABASE_URL_NEW_RUNTIME) {
    const r = new URL(process.env.DATABASE_URL_NEW_RUNTIME); const u = new URL(target);
    u.username = r.username; u.password = r.password;
    candidatos.push({ rol: decodeURIComponent(r.username) + ' (hereda de ' + ROL + ')', url: u.toString() });
  }
  let c = null; let usado = null; const fallos = [];
  for (const cand of candidatos) {
    try {
      const t = new Client({ connectionString: cand.url, connectionTimeoutMillis: 15000 });
      await t.connect(); c = t; usado = cand.rol; break;
    } catch (e) { fallos.push(`${cand.rol}: ${e.code}`); }
  }
  if (!c) {
    console.log(`\n  ⓘ NO MEDIDO: ninguna credencial de runtime conectó (${fallos.join(' · ')}).`);
    console.log('     Los grants SÍ se aplicaron; lo que falta es la comprobación. Pasá APP_RUNTIME_PASSWORD.');
    return;
  }
  console.log(`\n  verificación conectado COMO ${usado}:`);
  const ok = (b, m) => console.log(b ? '   ✓ ' + m : '   ✗ ' + m);

  // La trampa #1 del proyecto: sin tenant en la sesión, RLS devuelve 0 filas SIN error.
  const n = Number((await c.query('select count(*)::int n from identity.users')).rows[0].n);
  ok(n === 0, `sin tenant, identity.users devuelve 0 filas (dio ${n}) — RLS está filtrando`);

  // Y el shim de public: si no tiene security_invoker, evalúa RLS como su DUEÑO
  // y entrega el padrón entero con los hashes bcrypt.
  try {
    const p = Number((await c.query('select count(*)::int n from public.users')).rows[0].n);
    ok(p === 0, `sin tenant, public.users devuelve 0 (dio ${p}) — security_invoker vivo`);
  } catch (e) { console.log(`   ⓘ public.users: ${e.code} ${e.message.slice(0, 60)}`); }

  // Escritura donde SÍ corresponde (§33: un SELECT no prueba un UPDATE).
  try {
    await c.query('update commercial.customers set updated_at = updated_at where false');
    ok(true, 'puede ESCRIBIR en commercial.customers (0 filas, pero el permiso se ejerció)');
  } catch (e) { ok(false, `no puede escribir en commercial.customers: ${e.code}`); }

  // Y la prueba NEGATIVA, que es la que hace que esto valga: kepler_ods lo
  // alimenta el shipper y en prod app_runtime NO puede escribirlo. Si acá
  // pudiera, la réplica estaría mintiendo en la dirección peligrosa.
  let rechazado = false;
  try { await c.query('update kepler_ods.kdm1 set sucursal = sucursal where false'); }
  catch (e) { rechazado = e.code === '42501'; }
  ok(rechazado, 'NO puede escribir en kepler_ods (igual que en prod)');

  await c.end();
}

// Se exportan para que `database/tests/test-mirror-readonly-negative.js` ejercite
// EXACTAMENTE estas funciones y no una copia: una copia se desincroniza y el test
// se queda verde midiendo un código que ya nadie corre.
module.exports = { openProdReadOnly, assertProdIsReadOnly, resolverUrls, LECTURA, TABLA_SONDA };

// El módulo se puede requerir sin que corra el CLI.
if (require.main !== module) return;

// ─────────────────────────────────────────────────────────────────────────────
const PENDIENTES = {
  plan: 'REP.5 — deriva mirror.plan del catálogo de prod',
  delta: 'REP.5 — los cuatro carriles',
  reconcile: 'REP.5 — anti-join de PKs con --max-pct',
  status: 'REP.7 — lee mirror.pull_ctl',
};

const cmd = process.argv[2];

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

if (cmd === 'doctor') {
  doctor().catch((e) => { console.error('\nERROR:', e.message, '\n'); process.exit(1); });
} else if (cmd === 'seed') {
  seed({ fromDump: arg('from-dump', null), jobs: Number(arg('jobs', 4)) })
    .catch((e) => { console.error('\nERROR:', e.message, '\n'); process.exit(1); });
} else if (cmd === 'grants') {
  grants().catch((e) => { console.error('\nERROR:', e.message, '\n'); process.exit(1); });
} else if (cmd === 'refresh-mv') {
  (async () => {
    const { target } = resolverUrls();
    if (!target) { console.error('\nFalta MIRROR_TARGET_URL.\n'); process.exit(2); }
    guard.assertSafeTarget('refresh-mv[destino]', { url: target });
    const r = await refreshMatviews(target);
    process.exit(r.rotas.length ? 1 : 0);
  })().catch((e) => { console.error('\nERROR:', e.message, '\n'); process.exit(1); });
} else if (cmd === 'migrate') {
  const ep = arg('expect-pending', null);
  migrate({ apply: process.argv.includes('--apply'), expectPending: ep === null ? null : Number(ep) })
    .catch((e) => { console.error('\nERROR:', e.message, '\n'); process.exit(1); });
} else if (PENDIENTES[cmd]) {
  // No un no-op silencioso: un subcomando que no hace nada y sale 0 se lee
  // igual que uno que funcionó.
  console.error(`\n"${cmd}" todavía no está implementado (${PENDIENTES[cmd]}).\n`);
  process.exit(3);
} else {
  console.error(`
Espejo PROD → LOCAL. Un archivo, un proceso, subcomandos.

  doctor                       corre los frenos, no toca nada
  seed [--from-dump=<f>]       restaura el RESPALDO NOCTURNO (no dumpea prod)
       [--jobs=N]              default: el .dump más nuevo de
                               %USERPROFILE%\\backups\\trade_marketing
  migrate [--apply]            drift + ledger fantasma + knex. Dry-run por default.
          [--expect-pending=N] aborta si el número de pendientes no es el esperado
  grants                       replica la MATRIZ de permisos de prod (no un GRANT ALL)

  pendientes: ${Object.keys(PENDIENTES).join(' · ')}

Variables:
  MIRROR_SOURCE_URL   origen, sólo lectura (si falta, cae a FLEET_DB_URL)
  MIRROR_TARGET_URL   destino (sin default)
`);
  process.exit(2);
}
