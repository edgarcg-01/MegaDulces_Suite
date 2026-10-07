/* eslint-disable no-console */
/**
 * `[CT.9]` A QUÉ BASE LE ESTÁS PREGUNTANDO — resolvedor ÚNICO del destino "producción".
 *
 * ── El defecto que cierra, medido el 2026-09-25 ──────────────────────────────────────────────
 * Producción se mudó de Railway a `md` el 2026-09-22. `FLEET_DB_URL` —la variable que **48 de
 * los 52** consumidores usan creyendo que es prod, y que sus propios comentarios documentan como
 * *"la URL de PROD"*— **siguió apuntando a Railway**. Y Railway **no está apagado**:
 *
 *     Railway  (FLEET_DB_URL) .... clúster 7644730674938200108 · base `railway` · 838 migraciones
 *     prod real (md:5434) ........ clúster 7688376744939610156 · base `railway` · 861 migraciones
 *
 * Los dos se llaman `railway`, los dos responden, y el equivocado va 23 migraciones atrás. O sea
 * que un script que pide "prod" **no falla: triunfa en el lugar equivocado**, devuelve filas
 * plausibles y publica un número viejo. Es el mismo modo de falla de `[VL.18]`, que costó que el
 * guion documentado para migrar prod escribiera en el clúster que no era.
 *
 * ⛔ Lo que arrastró: la **suite de regresión completa** (`database/run-all-tests.js` y ~24
 * pruebas) lee `FLEET_DB_URL` **antes** que `DATABASE_URL_NEW`, así que desde el corte lleva
 * validando Railway. Cada verde que reportó es sobre el clúster equivocado.
 *
 * ── La regla ────────────────────────────────────────────────────────────────────────────────
 * ⭐ **El nombre de la variable no es evidencia de nada; la identidad del clúster sí.**
 * `pg_control_system().system_identifier` es lo único que distingue prod de una copia: el nombre
 * de la base, el esquema y hasta los datos pueden ser iguales.
 *
 * ⭐ Y la segunda mitad, que es la que vuelve el arreglo estructural en vez de una convención:
 * el handle de prod debe ser una **cuenta de sólo lectura** (`[SEG.4]`: `dev_ro`). Así, un guion
 * que se equivoque e intente escribir **no puede**, en vez de lograrlo. No depende de que nadie
 * se acuerde de nada.
 *
 *   const { resolverProd } = require('./lib/destino-prod');
 *   const knex = await resolverProd();        // ya verificado, o lanza
 *
 * ⚠️ `PROD_CLUSTER_ID` cambia si prod se restaura desde cero en otro clúster. Ese día hay que
 * actualizarlo A MANO y decir por qué — que es justamente el punto: un destino nuevo tiene que
 * ser una decisión escrita, no algo que ocurra porque una variable cambió sola.
 */
const path = require('path');

const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';

/** El clúster viejo, sólo para poder decir "estás en Railway" en vez de "no coincide". */
const CONOCIDOS = {
  '7688376744939610156': 'prod on-prem (md:5434)',
  '7644730674938200108': 'Railway — la prod VIEJA, de la que nos mudamos el 2026-09-22',
};

/**
 * Orden a propósito: primero lo explícito, y `FLEET_DB_URL` **última** porque es la que quedó
 * vieja. La lista no decide nada — cualquiera de las tres pasa igual por la compuerta.
 */
function urlDeProd() {
  return (
    process.env.PROD_DB_URL ||
    process.env.DATABASE_URL_NEW_PROD ||
    process.env.FLEET_DB_URL ||
    null
  );
}

/** Enmascara la cadena de conexión: nunca se imprime una credencial. */
function sinClave(url) {
  return String(url || '').replace(/:\/\/[^@]*@/, '://***@');
}

/**
 * Verifica la identidad contra una conexión ya abierta (knex o pg.Client).
 * Devuelve `{ ok, id, db, escribible }`; NO lanza, para que el llamador decida.
 */
async function medirDestino(conn) {
  const sql =
    "select (select system_identifier from pg_control_system())::text as id, " +
    'current_database() as db, current_user as usuario, ' +
    "current_setting('default_transaction_read_only') as solo_lectura";
  const r = conn.raw ? await conn.raw(sql) : await conn.query(sql);
  const fila = (r.rows || r)[0];
  return {
    ok: fila.id === PROD_CLUSTER_ID,
    id: fila.id,
    db: fila.db,
    usuario: fila.usuario,
    soloLectura: fila.solo_lectura === 'on',
    conocido: CONOCIDOS[fila.id] || 'desconocido',
  };
}

/** El mensaje que explica el error, con el arreglo al lado. */
function explicar(m) {
  return (
    `DESTINO EQUIVOCADO — no es producción.\n` +
    `  clúster conectado : ${m.id}  (${m.conocido}, base "${m.db}")\n` +
    `  clúster de prod   : ${PROD_CLUSTER_ID}  (${CONOCIDOS[PROD_CLUSTER_ID]})\n` +
    `\n` +
    `  Casi seguro estás cayendo en \`FLEET_DB_URL\`, que apunta a Railway y NO se apagó.\n` +
    `  Definí \`PROD_DB_URL\` en .env con una cuenta de SOLO LECTURA (ver ops/prod/README.md §2.2):\n` +
    `      PROD_DB_URL=postgresql://<usuario>:<clave>@192.168.0.222:5434/railway`
  );
}

/**
 * Abre prod y lo verifica. Lanza con un mensaje que dice qué pasó y cómo se arregla.
 * `exigirSoloLectura` (default true) también exige que la cuenta no pueda escribir: es lo que
 * hace imposible —no improbable— que un guion de reporte mute producción.
 */
async function resolverProd({ exigirSoloLectura = true } = {}) {
  const url = urlDeProd();
  if (!url) {
    throw new Error(
      'Falta el destino de prod. Definí `PROD_DB_URL` en .env con una cuenta de solo lectura ' +
        '(ops/prod/README.md §2.2). ⛔ NO uses `FLEET_DB_URL`: apunta a Railway.',
    );
  }
  const knex = require(path.resolve(__dirname, '..', '..', '..', 'node_modules', 'knex'))({
    client: 'pg',
    connection: url,
    pool: { min: 0, max: 2 },
  });
  let m;
  try {
    m = await medirDestino(knex);
  } catch (e) {
    await knex.destroy().catch(() => {});
    throw new Error(`No se pudo medir el destino (${sinClave(url)}): ${e.message}`);
  }
  if (!m.ok) {
    await knex.destroy().catch(() => {});
    throw new Error(explicar(m));
  }
  if (exigirSoloLectura && !m.soloLectura) {
    await knex.destroy().catch(() => {});
    throw new Error(
      `El destino ES producción, pero la cuenta \`${m.usuario}\` puede ESCRIBIR.\n` +
        `  Un guion de reporte no debe poder mutar prod ni por accidente.\n` +
        `  Usá una cuenta \`dev_ro\` (ops/prod/README.md §2.2), o pasá { exigirSoloLectura: false }\n` +
        `  si de verdad este guion tiene que escribir — y dejá dicho por qué.`,
    );
  }
  return knex;
}

module.exports = { PROD_CLUSTER_ID, CONOCIDOS, urlDeProd, sinClave, medirDestino, explicar, resolverProd };
