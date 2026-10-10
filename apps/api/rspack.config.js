/**
 * Config de rspack de la api. Reemplaza a `apps/api/webpack.config.js`.
 *
 * ── ⛔ Por qué es una FUNCIÓN y no un objeto (el bug que costó el primer CI) ──
 * El primer port exportaba un objeto plano, calcado del config de webpack, y el
 * build murió con `Entry is required`. La causa está en
 * `@nx/rspack/dist/src/executors/rspack/lib/config.js`:
 *
 *     else if (userDefinedConfig) {
 *       if (typeof userDefinedConfig === 'function') { ... }
 *       // New behavior, we want the rspack config to export object
 *       return userDefinedConfig;     // ← DEVUELVE SÓLO EL DEL USUARIO
 *     }
 *
 * O sea: un objeto plano **reemplaza** el config que `withNx(options)` ya
 * construyó —el que trae `entry` derivado de `main`, el output, los loaders—
 * mientras que una **función lo RECIBE como primer argumento** y lo extiende.
 * `@nx/webpack` mergeaba objetos; rspack no. Misma forma de config, semántica
 * opuesta, y el síntoma aparece lejos de la causa.
 *
 * ── Qué hace falta hacer acá y qué no ───────────────────────────────────────
 * Todo lo que el `NxAppWebpackPlugin` recibía (`main`, `tsConfig`, `outputPath`,
 * `assets`, `generatePackageJson`, `optimization`, `outputHashing`) lo lee el
 * EXECUTOR desde `project.json` y lo aplica `withNx` antes de llamarnos. Por eso
 * acá no se instancia ningún plugin de Nx: duplicarlo lo aplicaría dos veces.
 * Queda sólo lo que no se puede declarar en el `project.json`:
 *
 *   1. los `externals`, que son una función;
 *   2. `jsc.loose = false` en el swc-loader.
 *
 * ── El `loose`, que es el que ya rompió producción dos veces ────────────────
 * `@nx/webpack` le pasa al swc-loader `loose: true` **hardcodeado**, y por eso
 * el config viejo traía un plugin (`SwcSinLoose`) para desactivarlo. En ese modo
 * SWC emite dos atajos que no cumplen la spec:
 *
 *   1. una clase decorada que hereda de una clase ES2015 real llama al padre con
 *      `_Padre.apply(this, arguments)` → `TypeError: Class constructor cannot be
 *      invoked without 'new'`, y **todo `PUT /api/users/:id` daba 500**;
 *   2. `[...new Set(x)]` sale como `[].concat(new Set(x))`, que deja el Set
 *      ADENTRO del array → el `22P02` del sell-out y seis incidentes más.
 *
 * ⭐ `@nx/rspack` **no pasa `loose`** (la palabra no aparece en el paquete
 * 23.2.1), así que hereda el default de swc, que es `false`. Verificado con
 * `@swc/core` sobre el mismo fuente: con las opciones que pasa `@nx/rspack` el
 * spread sale con el helper que ITERA, no con `[].concat(`.
 *
 * Aun así se fija explícito: un default correcto que nadie declaró puede cambiar
 * en una versión menor, y acá el modo de falla no es un build roto sino un
 * bundle que compila verde y miente en runtime. `scripts/check-bundle-downlevel.js`
 * vigila el artefacto por si esto llegara a fallar.
 *
 * ⚠️ El `jsc.target` NO se toca: el bundle se sigue emitiendo downleveleado,
 * igual que con webpack. Cambiar de bundler y de target a la vez haría imposible
 * atribuir un fallo.
 */

/** Marca como externo lo que no debe entrar al bundle. Calcado del config de webpack. */
function externals({ request }, callback) {
  // @duckdb/node-api (Presupuestos rollup, ADR-075) es ESM-only + nativo: external de tipo
  // `import` → el bundler lo deja como import() en runtime (el bundle CJS carga ESM así) y lo
  // detecta generatePackageJson (para que el deploy instale su binario). NO va como 'commonjs'
  // (require de un ESM revienta) ni oculto (no lo instalaría el deploy).
  if (request === '@duckdb/node-api' || request.startsWith('@duckdb/node-api/')) {
    return callback(null, 'import ' + request);
  }
  const paquetes = [
    '@nestjs/websockets',
    '@nestjs/microservices',
    '@fastify/static',
    'class-transformer',
    'class-validator',
    'file-type',
    'knex',
    'pg',
    'pg-native',
    'socket.io',
  ];
  // Coincide con el paquete o con un sub-path (ej. class-transformer/storage).
  if (paquetes.some((p) => request === p || request.startsWith(p + '/'))) {
    return callback(null, 'commonjs ' + request);
  }
  callback();
}

/** Fuerza `jsc.loose = false` en el swc-loader que agregó `applyBaseConfig`. */
function sinLoose(config) {
  for (const rule of config.module?.rules ?? []) {
    if (!rule || typeof rule !== 'object') continue;
    const loader = typeof rule.loader === 'string' ? rule.loader : '';
    if (!loader.includes('swc-loader')) continue;
    rule.options = rule.options ?? {};
    rule.options.jsc = { ...(rule.options.jsc ?? {}), loose: false };
  }
}

module.exports = (config) => {
  config.externals = [externals];
  sinLoose(config);
  return config;
};
