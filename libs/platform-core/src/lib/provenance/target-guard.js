'use strict';
/**
 * `[REP.0.1]` — Guarda de destino y de ORIGEN, compartida.
 *
 * ── Por qué existe, y por qué acá ────────────────────────────────────────────
 * Nació en `database/tests/_lib/assert-safe-target.js` el 2026-08-29, después de
 * que la suite corriera con el `.env` apuntando a PRODUCCIÓN y dejara 5 cuentas
 * y 2 tenants de prueba en el padrón real. Se sube a `libs/` por ADR-056: un
 * primitivo no cierra la fase hasta vivir compartido. El archivo de
 * `database/tests/_lib/` quedó como re-export — los 34 llamadores no se tocan.
 *
 * ── Por qué es CommonJS y no TypeScript ──────────────────────────────────────
 * El repo ya tiene el patrón `ts-node/register` para que un script CJS de
 * `database/` consuma un `.ts` de `libs/` (lo hacen 4 archivos). Acá no sirve:
 * medido, `ts-node.register()` cuesta **~1.4 s por proceso** en caliente y 12 s
 * en frío. Esto es lo PRIMERO que corre cada script que escribe, y meterle un
 * compilador al camino de arranque de una guarda es agregarle un modo de falla
 * a la cosa cuyo trabajo es no fallar. Cero dependencias, `require()` directo.
 * Los tipos para TS viven en `target-guard.d.ts`, al lado.
 *
 * ── Las dos preguntas ────────────────────────────────────────────────────────
 * `assertSafeTarget` (el de siempre) responde *"¿puedo ESCRIBIR acá?"*.
 * `assertTarget` responde también *"¿es este el ORIGEN que esperaba?"*, que es
 * la que nadie construye: si un pull de prod→local recibe un origen local,
 * **termina bien y no copia nada**. Ese éxito silencioso es exactamente lo que
 * dejó el ODS congelado 6 días. Precedentes del mismo reflejo en el repo:
 * `ops/ingest/make-env.js` se niega si origen y latido comparten host, y
 * `run-prod-feeds.js` se niega a `--apply` si el destino no es Railway.
 *
 * NO imprime la URL: lleva credenciales. Sólo host y nombre de base.
 */

/** Hosts/bases que son PRODUCCIÓN. Gana sobre cualquier otra cosa. */
const PROD_PATTERNS = [/rlwy\.net/i, /railway\.internal/i, /\.railway\.app/i];
const PROD_DB_NAMES = new Set(['railway']);

/** Hosts que son una DB local y desechable. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);

/**
 * La DB compartida de la oficina (`192.168.0.245`). NO es local: es de los tres
 * devs a la vez (`docs/GOTCHAS.md` §17/§24/§25). `assertSafeTarget` la permite
 * avisando, porque es el destino documentado del suite. `assertTarget` con
 * `expect:'local'` la RECHAZA — ver la nota de `assertTarget`.
 */
const SHARED_HOSTS = new Set(['192.168.0.245']);

function parse(url) {
  try {
    // `postgres://` no es un esquema que `URL` entienda nativamente para
    // `hostname`/`pathname`, pero sí lo parsea como URL genérica.
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || '5432',
      db: decodeURIComponent(u.pathname || '').replace(/^\//, ''),
    };
  } catch {
    return { host: null, port: null, db: null };
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
 * Cómo resuelven la URL los tests de `database/tests/`, en el mismo orden.
 *
 * A propósito NO cae a `DATABASE_URL` (la legacy): los tests de acá usan
 * `DATABASE_URL_NEW*`. Caer a otra variable haría que el guard califique una
 * base DISTINTA de la que el test va a abrir — y eso ya pasó al probarlo: con
 * `DATABASE_URL_NEW` vacía, la legacy apunta a `localhost` y el destino salía
 * "local" (seguro) mientras el test intentaba conectarse a otra cosa.
 * Var vacía = destino desconocido.
 */
function resolveUrl() {
  return process.env.DATABASE_URL_NEW_RUNTIME || process.env.DATABASE_URL_NEW || null;
}

function abortar(lineas) {
  console.error('\n' + lineas.join('\n') + '\n');
  process.exit(2);
}

/**
 * Aborta el proceso si el destino no es seguro para ESCRIBIR.
 * Comportamiento histórico, sin cambios: los 34 llamadores siguen igual.
 *
 * @param {string} nombre nombre del test, para que el mensaje diga quién abortó.
 * @param {{url?:string}} [opts]
 */
function assertSafeTarget(nombre, opts = {}) {
  const url = opts.url || resolveUrl();
  const res = classify(url);
  const donde = `${res.host || '(host desconocido)'}/${res.db || '(base desconocida)'}`;

  if (res.kind === 'prod') {
    abortar([
      `ABORT (${nombre}): el destino es PRODUCCIÓN → ${donde}`,
      'Este test ESCRIBE y BORRA. Apuntá DATABASE_URL_NEW a la DB local o a la compartida antes de correrlo.',
    ]);
  }
  if (res.kind === 'desconocido') {
    abortar([
      `ABORT (${nombre}): no reconozco el destino → ${donde}`,
      'Este test ESCRIBE y BORRA, y sin reconocer la base no escribo (fail-closed).',
      `Si es tu DB de desarrollo, declarala: TEST_TARGET_ALLOW=${res.host || '<host>'}`,
    ]);
  }
  if (res.kind === 'compartida') {
    console.warn(
      `  ! ${nombre}: escribiendo en la DB COMPARTIDA (${donde}). No es tu local — los otros devs la ven.`,
    );
  }
  return res;
}

/**
 * La versión bidireccional. Aborta si el destino no es EXACTAMENTE lo esperado.
 *
 * @param {string} nombre quién pregunta (sale en el mensaje).
 * @param {{url:string, intent:'read'|'write', expect:'prod'|'local'}} opts
 *
 * Dos decisiones deliberadas, y las dos son más estrictas que `assertSafeTarget`:
 *
 *  1. **`expect:'local'` rechaza la compartida (`.245`).** `assertSafeTarget` la
 *     deja pasar avisando porque es el destino documentado del suite. Pero acá
 *     el llamador dijo "local", y `.245` la ven los otros dos devs. Si alguien
 *     de verdad quiere apuntar a la compartida, que pida `expect:'compartida'`.
 *
 *  2. **`TEST_TARGET_ALLOW` NO abre la puerta cuando `intent:'write'`.** Esa
 *     válvula existe para que un dev apunte los TESTS a su caja. Un script que
 *     hace `DROP DATABASE` y restaura 25 GB tiene otro radio de explosión, y
 *     por lo tanto otra puerta. La variable sigue valiendo para lectura y para
 *     el comportamiento histórico de `assertSafeTarget`.
 */
function assertTarget(nombre, opts = {}) {
  const { url, intent, expect } = opts;
  if (intent !== 'read' && intent !== 'write') {
    throw new Error(`assertTarget(${nombre}): 'intent' tiene que ser 'read' o 'write'.`);
  }
  if (expect !== 'prod' && expect !== 'local' && expect !== 'compartida') {
    throw new Error(`assertTarget(${nombre}): 'expect' tiene que ser 'prod', 'local' o 'compartida'.`);
  }

  const res = classify(url);
  const donde = `${res.host || '(host desconocido)'}/${res.db || '(base desconocida)'}`;

  // Escribir en prod: nunca, por ninguna vía. Se chequea primero y aparte,
  // para que el mensaje diga lo que importa aunque `expect` venga mal puesto.
  if (intent === 'write' && res.kind === 'prod') {
    abortar([
      `ABORT (${nombre}): pediste ESCRIBIR y el destino es PRODUCCIÓN → ${donde}`,
      'No hay escape para esto.',
    ]);
  }

  // Cuando se escribe, `TEST_TARGET_ALLOW` no cuenta: se re-clasifica sin ella.
  let kind = res.kind;
  if (intent === 'write' && process.env.TEST_TARGET_ALLOW) {
    const orig = process.env.TEST_TARGET_ALLOW;
    delete process.env.TEST_TARGET_ALLOW;
    try {
      kind = classify(url).kind;
    } finally {
      process.env.TEST_TARGET_ALLOW = orig;
    }
    if (kind !== res.kind) {
      console.warn(
        `  ! ${nombre}: TEST_TARGET_ALLOW no aplica a una operación de ESCRITURA. ${donde} se evalúa sin ella.`,
      );
    }
  }

  if (kind === expect) return res;

  const explicacion =
    intent === 'read' && expect === 'prod'
      ? [
          'Un pull que lee de la base equivocada TERMINA BIEN Y NO COPIA NADA.',
          'Ese éxito silencioso es peor que un error: nadie lo mira.',
        ]
      : [`Se esperaba un destino '${expect}' y este clasifica como '${kind}'.`];

  abortar([
    `ABORT (${nombre}): el ${intent === 'read' ? 'ORIGEN' : 'DESTINO'} no es lo que se esperaba.`,
    `  esperado: ${expect}`,
    `  recibido: ${kind} → ${donde}`,
    ...explicacion.map((l) => '  ' + l),
  ]);
}

/**
 * Aborta si dos URLs apuntan a la misma base física.
 *
 * Compara `host:port/db`, **no la URL entera**: `postgres://a@h/db` y
 * `postgres://b@h/db` son la misma base con distinta credencial, y un espejo
 * que se copia sobre sí mismo pasa todos los chequeos de arriba. Es el mismo
 * reflejo de `ops/ingest/make-env.js`, generalizado.
 */
function assertDistinct(nombre, urlA, urlB) {
  const a = parse(urlA);
  const b = parse(urlB);
  const claveA = `${a.host}:${a.port}/${a.db}`;
  const claveB = `${b.host}:${b.port}/${b.db}`;
  if (claveA === claveB) {
    abortar([
      `ABORT (${nombre}): el origen y el destino son la MISMA base → ${claveA}`,
      '  Distinta credencial no es distinta base. Una copia sobre sí misma no falla, no copia.',
    ]);
  }
  return { a: claveA, b: claveB };
}

/**
 * Aborta si el destino NO es PRODUCCIÓN. El INVERSO de `assertSafeTarget`/`assertTarget`.
 *
 * Para los que LEGÍTIMAMENTE escriben a prod: el orquestador `run-prod-feeds` y los
 * importers on-prem del runner. Éstos NO pueden usar `assertTarget({intent:'write'})`,
 * que prohíbe escribir a prod "por ninguna vía" (pensado para tests) — su trabajo ES
 * escribir a prod. Lo que hay que evitar es pegarle SIN QUERER a la DB local o compartida:
 * el incidente MR (auditoría con `$375M` de inventario fantasma que en realidad era
 * `platform_test`) fue exactamente eso — un prod-writer resolviendo mal su destino.
 *
 * Antes cada prod-writer traía su propio `/railway/.test(url)` (run-prod-feeds lo tenía
 * inline). Esto lleva la decisión al mismo `classify()` que ya distingue prod de
 * local/compartida/desconocido (ADR-056: un primitivo, un dueño).
 *
 * @param {string} nombre quién pide (sale en el mensaje).
 * @param {{url?:string}} [opts] `url` explícita; si falta, `resolveUrl()` (DATABASE_URL_NEW).
 * @returns {{kind:string, host:string|null, db:string|null}} la clasificación (kind==='prod').
 */
function assertProdTarget(nombre, opts = {}) {
  const url = opts.url || resolveUrl();
  const res = classify(url);
  const donde = `${res.host || '(host desconocido)'}/${res.db || '(base desconocida)'}`;
  if (res.kind !== 'prod') {
    abortar([
      `ABORT (${nombre}): el DESTINO no es PRODUCCIÓN → ${donde} (clasifica como '${res.kind}').`,
      'Este proceso ESCRIBE a prod (feeds del runner). Un destino equivocado escribe la copia',
      'sin fallar y nadie lo mira — como el incidente MR ($375M fantasma = platform_test).',
      'Exportá DATABASE_URL_NEW al proxy Railway de prod, o pasá --local para poblar dev.',
    ]);
  }
  return res;
}

module.exports = { assertSafeTarget, assertTarget, assertProdTarget, assertDistinct, classify };
