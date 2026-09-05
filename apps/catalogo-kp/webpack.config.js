const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');

/**
 * Fuerza `jsc.loose = false` en el swc-loader que inyecta nx.
 *
 * Copiado tal cual de `apps/api/webpack.config.js` — mismo motivo: `@nx/webpack`
 * pasa `loose: true` hardcodeado al swc-loader inline, y con `legacyDecorator`
 * eso rompe la herencia de clases nativas (`PartialType` de @nestjs/swagger,
 * `[...new Set()]`). Este app no usa DTOs/swagger hoy, pero mantener el mismo
 * plugin evita divergencia si algún día se agrega uno, y no tiene costo.
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
    function ({ request }, callback) {
      const externals = ['knex', 'pg', 'pg-native'];
      if (externals.some((pkg) => request === pkg || request.startsWith(pkg + '/'))) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    },
  ],
  plugins: [
    new NxAppWebpackPlugin({
      target: 'node',
      compiler: 'swc',
      main: './src/main.ts',
      tsConfig: './tsconfig.app.json',
      optimization: false,
      outputHashing: 'none',
      generatePackageJson: true,
    }),
    new SwcSinLoose(),
  ],
};
