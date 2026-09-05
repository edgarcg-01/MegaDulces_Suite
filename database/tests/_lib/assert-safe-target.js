'use strict';
/**
 * `[IDG.1]` — Guarda de destino para los tests que ESCRIBEN.
 *
 * Por qué existe: el 2026-08-29 el suite se corrió con el `.env` apuntando a
 * PRODUCCIÓN. Dejó 5 cuentas y 2 tenants de prueba en el padrón real, y una de
 * esas cuentas (`hacker`) sobrevivió porque el cleanup de su test sólo barre el
 * tenant ajeno. 37 archivos de `database/tests/` hacen DELETE / TRUNCATE / DROP
 * y ninguno miraba contra qué base estaba corriendo; 4 de ellos crean y borran
 * tenants con el rol `postgres`, que además bypassa RLS.
 *
 * Calca la guarda que ya funciona en `database/importers/_smoke-sink-mirror.js`,
 * con una diferencia deliberada: **allowlist, no blocklist**. El regex de allá
 * (`/proxy\.rlwy\.net|railway/i`) sólo reconoce Railway y NO reconoce
 * `192.168.0.245`, que es la DB compartida entre devs a la que el `.env` apunta
 * hoy. Un destino que no sé clasificar es un destino donde no escribo.
 *
 *   prod        → exit(2). Siempre, sin escape.
 *   local       → pasa.
 *   compartida  → pasa avisando (es el destino documentado hoy, y es de todos).
 *   desconocido → exit(2), con la instrucción de cómo declararlo.
 *
 * NO imprime la URL: lleva credenciales. Sólo host y nombre de base.
 *
 * Uso, como PRIMERA línea ejecutable del test (después de dotenv):
 *
 *     require('./_lib/assert-safe-target').assertSafeTarget('test-foo');
 *
 * Si el test resuelve su URL de una forma propia, pasársela:
 *
 *     assertSafeTarget('test-foo', { url: miUrl });
 */

/** Hosts/bases que son PRODUCCIÓN. Gana sobre cualquier otra cosa. */
const PROD_PATTERNS = [/rlwy\.net/i, /railway\.internal/i, /\.railway\.app/i];
const PROD_DB_NAMES = new Set(['railway']);

/** Hosts que son una DB local y desechable. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

/**
 * La DB compartida de la oficina. NO es local: es de los tres devs a la vez
 * (ver `docs/GOTCHAS.md` §17/§25 y ONBOARDING §"Alternativa"). Se permite porque
 * es el destino documentado del suite, pero se avisa en cada corrida.
 */
const SHARED_HOSTS = new Set(['192.168.0.245']);

function parse(url) {
  try {
    // `postgres://` no es un esquema que `URL` entienda nativamente para
    // `hostname`/`pathname`, pero sí lo parsea como URL genérica.
    const u = new URL(url);
    return { host: u.hostname, db: decodeURIComponent(u.pathname || '').replace(/^\//, '') };
  } catch {
    return { host: null, db: null };
  }
}

/**
 * Clasifica un destino. Exportada aparte para poder testearla sin matar el proceso.
 * @returns {{kind:'prod'|'local'|'compartida'|'desconocido', host:string|null, db:string|null}}
 */
function classify(url) {
  if (!url) return { kind: 'desconocido', host: null, db: null };
  const { host, db } = parse(url);

  // 1. Prod primero, y por dos caminos: el patrón del host y el nombre de la
  //    base. En Railway la base se llama `railway` — si algún día el host cambia
  //    de dominio, el nombre sigue delatándola.
  if (PROD_PATTERNS.some((rx) => rx.test(url)) || (db && PROD_DB_NAMES.has(db))) {
    return { kind: 'prod', host, db };
  }
  // 2. La URL de prod explícita del entorno, sea el host que sea.
  const fleet = process.env.FLEET_DB_URL;
  if (fleet && url === fleet) return { kind: 'prod', host, db };

  if (host && LOCAL_HOSTS.has(host)) return { kind: 'local', host, db };
  if (host && SHARED_HOSTS.has(host)) return { kind: 'compartida', host, db };

  // 3. Declaración explícita de un host extra permitido (dev con su propia caja).
  //    No es un bypass: el chequeo de prod ya corrió arriba.
  const extra = (process.env.TEST_TARGET_ALLOW || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (host && extra.includes(host)) return { kind: 'local', host, db };

  return { kind: 'desconocido', host, db };
}

/**
 * Cómo resuelven la URL los tests de este directorio, en el mismo orden.
 *
 * A propósito NO cae a `DATABASE_URL` (la legacy): los 155 tests de acá usan
 * `DATABASE_URL_NEW*` (112 + 23 referencias medidas, cero a otra cosa). Caer a
 * otra variable haría que el guard califique una base DISTINTA de la que el test
 * va a abrir — y eso ya pasó al probarlo: con `DATABASE_URL_NEW` vacía, la
 * legacy apunta a `localhost` y el destino salía "local" (seguro) mientras el
 * test intentaba conectarse a otra cosa. Var vacía = destino desconocido.
 */
function resolveUrl() {
  return process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW || null;
}

/**
 * Aborta el proceso si el destino no es seguro para escribir.
 * @param {string} nombre nombre del test, para que el mensaje diga quién abortó.
 * @param {{url?:string}} [opts]
 */
function assertSafeTarget(nombre, opts = {}) {
  const url = opts.url || resolveUrl();
  const res = classify(url);
  const donde = `${res.host || '(host desconocido)'}/${res.db || '(base desconocida)'}`;

  if (res.kind === 'prod') {
    console.error(
      `\nABORT (${nombre}): el destino es PRODUCCIÓN → ${donde}\n` +
        `Este test ESCRIBE y BORRA. Apuntá DATABASE_URL_NEW a la DB local o a la compartida antes de correrlo.\n`,
    );
    process.exit(2);
  }
  if (res.kind === 'desconocido') {
    console.error(
      `\nABORT (${nombre}): no reconozco el destino → ${donde}\n` +
        `Este test ESCRIBE y BORRA, y sin reconocer la base no escribo (fail-closed).\n` +
        `Si es tu DB de desarrollo, declarala: TEST_TARGET_ALLOW=${res.host || '<host>'}\n`,
    );
    process.exit(2);
  }
  if (res.kind === 'compartida') {
    console.warn(
      `  ! ${nombre}: escribiendo en la DB COMPARTIDA (${donde}). No es tu local — los otros devs la ven.`,
    );
  }
  return res;
}

module.exports = { assertSafeTarget, classify };
