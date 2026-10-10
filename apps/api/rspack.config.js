const { NxAppRspackPlugin } = require('@nx/rspack/app-plugin');

/**
 * Config de rspack de la api. Port 1:1 del `webpack.config.js` que reemplaza.
 *
 * ── Por qué rspack y no esbuild ─────────────────────────────────────────────
 * rspack mantiene la API de configuración de webpack (los `externals` de abajo
 * entran tal cual) y compila con **swc**, que es lo que la api ya usaba. Nest
 * necesita `legacyDecorator` + `decoratorMetadata` para su DI y para
 * class-validator; esbuild **no emite `emitDecoratorMetadata`**, así que
 * migrar ahí exigiría un plugin de decoradores — justo la capa que ya costó
 * dos incidentes acá. rspack no toca esa capa.
 *
 * ── El `loose` que NO hace falta, y que igual se fija ───────────────────────
 * `apps/api/webpack.config.js` traía un plugin (`SwcSinLoose`) porque
 * `@nx/webpack` le pasa al swc-loader `loose: true` **hardcodeado**, y en ese
 * modo SWC emite dos atajos que rompieron producción:
 *
 *   1. una clase decorada que hereda de una clase ES2015 real llama al padre
 *      con `_Padre.apply(this, arguments)` → `TypeError: Class constructor
 *      cannot be invoked without 'new'` (todo `PUT /api/users/:id` daba 500);
 *   2. `[...new Set(x)]` se emite como `[].concat(new Set(x))`, que deja el Set
 *      ADENTRO del array → el `22P02` del sell-out y seis incidentes más.
 *
 * ⭐ `@nx/rspack` **no pasa `loose`** (verificado leyendo
 * `dist/src/plugins/utils/apply-base-config.js` de la 23.2.1: la palabra no
 * aparece en el paquete), así que hereda el default de swc, que es `false`.
 * Medido con `@swc/core` sobre el mismo fuente: con las opciones que pasa
 * `@nx/rspack` el spread sale con el helper que ITERA, no con `[].concat(`.
 *
 * Aun así se fija explícito abajo. Un default correcto que nadie declaró es un
 * default que puede cambiar en una versión menor, y acá el modo de falla no es
 * un build roto: es un bundle que compila verde y miente en runtime. El candado
 * `scripts/check-bundle-downlevel.js` vigila el artefacto por si esto falla.
 *
 * ⚠️ Lo que NO cambia en este PR: el `jsc.target`. El bundle de hoy se emite
 * downleveleado y así se queda — cambiar de bundler y de target a la vez haría
 * imposible atribuir un fallo. El target va aparte, con su propia medición.
 */
class SwcLooseExplicito {
  apply(compiler) {
    const ajustar = () => {
      const rules = compiler.options?.module?.rules ?? [];
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const loader = typeof rule.loader === 'string' ? rule.loader : '';
        if (!loader.includes('swc-loader')) continue;
        rule.options = rule.options ?? {};
        rule.options.jsc = { ...(rule.options.jsc ?? {}), loose: false };
      }
    };
    compiler.hooks.beforeCompile.tap('SwcLooseExplicito', ajustar);
    compiler.hooks.watchRun.tap('SwcLooseExplicito', ajustar);
  }
}

module.exports = {
  externals: [
    // Función para marcar como externos todos los sub-paths conflictivos
    function ({ request }, callback) {
      // @duckdb/node-api (Presupuestos rollup, ADR-075) es ESM-only + nativo: external de tipo `import`
      // → el bundler lo deja como import() en runtime (el bundle CJS carga ESM así) y lo detecta
      // generatePackageJson (para que el deploy instale su binario). NO va como 'commonjs' (require de
      // un ESM revienta) ni oculto (no lo instalaría el deploy).
      if (request === '@duckdb/node-api' || request.startsWith('@duckdb/node-api/')) {
        return callback(null, 'import ' + request);
      }
      const externals = [
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

      // Si el request coincide con el paquete o es un sub-path (ej. class-transformer/storage)
      if (externals.some((pkg) => request === pkg || request.startsWith(pkg + '/'))) {
        return callback(null, 'commonjs ' + request);
      }

      callback();
    },
  ],
  plugins: [
    new NxAppRspackPlugin({
      target: 'node',
      // ⚠️ Sin `compiler: 'swc'`: en rspack no es una opción — swc es el único
      // compilador de TS (`builtin:swc-loader`, nativo). El `.swcrc` del proyecto
      // sigue sin aplicarse, igual que con webpack, porque las opciones se pasan
      // inline al loader; lo que hace falta se fija en el plugin de abajo.
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true, // de acá sale el manifiesto podado que instala `prod-deps`
    }),
    // DESPUÉS de NxAppRspackPlugin, para no depender del orden en que agrega su regla.
    new SwcLooseExplicito(),
  ],
};
