#!/usr/bin/env node
/**
 * `[PGP.122.4]` Empaqueta `ensayo.ts` —con el adaptador REAL del pedido TELEMARK, `pg` y nada más—
 * en UN archivo `.cjs` que corre con `node` pelón dentro de un contenedor en `md`. Espejo del de
 * `ensayo-requisicion-kepler`. Ver el README de `ensayo-pago-kepler`.
 *
 *   node ops/prod/ensayo-pedido-tlmk-kepler/empaquetar.js <salida.cjs>
 */
const path = require('node:path');
const esbuild = require('esbuild');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const salida = process.argv[2];
if (!salida) { console.error('Uso: node empaquetar.js <salida.cjs>'); process.exit(1); }

const NEST_MINIMO = `
exports.Injectable = () => () => undefined;
class Logger { constructor(n) { this.n = n; }
  log(m) { console.error('[' + this.n + '] ' + m); } warn(m) { console.error('[' + this.n + '] WARN ' + m); } error(m) { console.error('[' + this.n + '] ERROR ' + m); } }
exports.Logger = Logger;`;

esbuild.build({
  entryPoints: [path.join(__dirname, 'ensayo.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: salida,
  external: ['pg-native'],
  alias: {
    '@megadulces/platform-core': path.join(RAIZ, 'libs/platform-core/src/lib/kepler/kepler-servidor.ts'),
    // Sólo `redondear2` y `totalesCotizacion` (valores) salen del barril; su archivo no arrastra nada más.
    '@megadulces/contracts': path.join(RAIZ, 'libs/contracts/src/money/quote-totals.ts'),
  },
  plugins: [{
    name: 'nest-minimo',
    setup(b) {
      b.onResolve({ filter: /^@nestjs\/common$/ }, () => ({ path: 'nest-minimo', namespace: 'nest-minimo' }));
      b.onLoad({ filter: /.*/, namespace: 'nest-minimo' }, () => ({ contents: NEST_MINIMO, loader: 'js' }));
    },
  }],
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
  logLevel: 'warning',
}).then(() => console.log(`ok → ${salida}`)).catch(() => process.exit(1));
