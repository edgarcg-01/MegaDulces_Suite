const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');

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
      compiler: 'swc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true, // Vital para que Render sepa qué instalar
    }),
  ],
};