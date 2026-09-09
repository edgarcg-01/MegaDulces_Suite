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
 *   doctor       corre todos los frenos y NO TOCA NADA. Es lo único que existe hoy.
 *   plan         (pendiente) deriva `mirror.plan` del catálogo de prod
 *   seed         (pendiente) siembra por pg_dump/pg_restore
 *   migrate      (pendiente) knex + detector del ledger fantasma
 *   delta        (pendiente) las cuatro carriles
 *   reconcile    (pendiente) anti-join de PKs con --max-pct
 *   status       (pendiente) lee mirror.pull_ctl, veredicto ternario
 *
 * ── Variables ────────────────────────────────────────────────────────────────
 *   MIRROR_SOURCE_URL   origen. Si falta, cae a FLEET_DB_URL (ver nota abajo).
 *   MIRROR_TARGET_URL   destino. Sin default: un espejo sin destino declarado
 *                       no adivina dónde escribir.
 */

const path = require('path');
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

// Se exportan para que `database/tests/test-mirror-readonly-negative.js` ejercite
// EXACTAMENTE estas funciones y no una copia: una copia se desincroniza y el test
// se queda verde midiendo un código que ya nadie corre.
module.exports = { openProdReadOnly, assertProdIsReadOnly, resolverUrls, LECTURA, TABLA_SONDA };

// El módulo se puede requerir sin que corra el CLI.
if (require.main !== module) return;

// ─────────────────────────────────────────────────────────────────────────────
const PENDIENTES = {
  plan: 'REP.2 — deriva mirror.plan del catálogo de prod',
  seed: 'REP.3 — siembra por pg_dump/pg_restore',
  migrate: 'REP.3 — knex + detector del ledger fantasma',
  delta: 'REP.5 — los cuatro carriles',
  reconcile: 'REP.5 — anti-join de PKs con --max-pct',
  status: 'REP.7 — lee mirror.pull_ctl',
};

const cmd = process.argv[2];

if (cmd === 'doctor') {
  doctor().catch((e) => { console.error('\nERROR:', e.message, '\n'); process.exit(1); });
} else if (PENDIENTES[cmd]) {
  // No un no-op silencioso: un subcomando que no hace nada y sale 0 se lee
  // igual que uno que funcionó.
  console.error(`\n"${cmd}" todavía no está implementado (${PENDIENTES[cmd]}).\n`);
  process.exit(3);
} else {
  console.error(`
Espejo PROD → LOCAL. Un archivo, un proceso, subcomandos.

  node database/scripts/pull-prod-to-local.js doctor

Subcomandos: doctor${Object.keys(PENDIENTES).map((k) => ` · ${k} (pendiente)`).join('')}

Variables:
  MIRROR_SOURCE_URL   origen (si falta, cae a FLEET_DB_URL)
  MIRROR_TARGET_URL   destino (sin default)
`);
  process.exit(2);
}
