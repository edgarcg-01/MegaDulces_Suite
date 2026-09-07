const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');

/**
 * Fuerza `jsc.loose = false` en el swc-loader que inyecta nx.
 *
 * **Por qué hace falta un plugin y no alcanza `.swcrc`:** `@nx/webpack` pasa las
 * opciones de swc **inline** al loader (ver
 * `@nx/webpack/dist/src/plugins/nx-webpack-plugin/lib/compiler-loaders.js`), con
 * `loose: true` hardcodeado. Cuando swc-loader recibe opciones inline **ignora
 * el `.swcrc` por completo**, así que editar ese archivo no cambia nada. Se
 * comprobó: tras poner `"loose": false` en `.swcrc`, el bundle salía idéntico.
 *
 * **Qué rompía el modo loose:** con `legacyDecorator` (que Nest necesita para
 * DI y class-validator), SWC envuelve toda clase decorada en una función y
 * —sólo en loose— llama al padre con `_Padre.apply(this, arguments)`. Eso
 * funciona entre dos funciones ES5, pero explota si el padre es una clase
 * ES2015 real. Justo el caso de:
 *
 *     export class UpdateUserDto extends PartialType(UserWriteDto) { ... }
 *
 * `PartialType` viene de `@nestjs/swagger`, o sea de `node_modules`, que el
 * loader excluye → llega como clase nativa → `TypeError: Class constructor
 * PartialTypeClass cannot be invoked without 'new'` y **todo
 * `PUT /api/users/:id` respondía 500** en prod. `CreateUserDto` se salvaba de
 * casualidad: hereda de `UserWriteDto`, que SWC también degrada.
 *
 * Sin loose, SWC emite el super call con `Reflect.construct` y ambos casos
 * andan. El costo es un bundle marginalmente más grande.
 *
 * Se hace en `beforeCompile` y no en `apply` para no depender del orden en que
 * nx agrega su regla.
 */
class SwcSinLoose {
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
    compiler.hooks.beforeCompile.tap('SwcSinLoose', ajustar);
    compiler.hooks.watchRun.tap('SwcSinLoose', ajustar);
  }
}

module.exports = {
  externals: [
    // Función para marcar como externos todos los sub-paths conflictivos
    function ({ request }, callback) {
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
    new NxAppWebpackPlugin({
      target: 'node',
      // SWC: compila ~10-20x más rápido que tsc. Nest necesita metadata de
      // decoradores (DI + class-validator) → configurada en apps/api/.swcrc
      // (legacyDecorator + decoratorMetadata). Sin ese .swcrc, la DI de Nest
      // revienta en runtime ("can't resolve dependencies").
      //
      // ⚠️ `loose` en ese .swcrc tiene que quedarse en **false**. NO es
      // cosmético: en modo loose SWC emite atajos que no cumplen la spec, y ya
      // rompieron producción dos veces.
      //
      //  1. **Herencia de una clase NATIVA.** Con `legacyDecorator`, SWC
      //     envuelve toda clase decorada en una función y —en loose— llama al
      //     padre con `_Padre.apply(this, arguments)`. Si el padre es una clase
      //     ES2015 de verdad (`UpdateUserDto extends PartialType(UserWriteDto)`,
      //     donde `PartialType` viene de @nestjs/swagger y NO pasa por SWC),
      //     eso tira `Class constructor PartialTypeClass cannot be invoked
      //     without 'new'` y **todo PUT /api/users/:id devolvía 500**. Sin
      //     loose, SWC usa `Reflect.construct` y funciona. `CreateUserDto` se
      //     salvaba de casualidad: su padre también lo degrada SWC, así que el
      //     `.apply` entre dos funciones ES5 no se queja.
      //  2. **`[...new Set()]`**, que en loose se compila asumiendo array-like
      //     y devuelve el Set sin iterar → el 22P02 de `destKinds`.
      //
      // El costo es un bundle marginalmente más grande. Lo que compra es que el
      // JS emitido se comporte como el TS que escribimos.
      compiler: 'swc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true, // Vital para que Render sepa qué instalar
    }),
    // DESPUÉS de NxAppWebpackPlugin: le quita el `loose: true` que nx hardcodea
    // en el swc-loader. Ver el comentario de la clase.
    new SwcSinLoose(),
  ],
};