#!/usr/bin/env node
/**
 * `[PQ.110]` Empaqueta `ensayo.ts` —con el adaptador REAL, `pg` y nada más— en UN archivo `.cjs`
 * que corre con `node` pelón dentro de un contenedor en `md`. Ver `README.md`.
 *
 *   node ops/prod/ensayo-cancelar-oc/empaquetar.js <salida.cjs>
 *
 * `@nestjs/common` se cambia por un sustituto de diez líneas (`Injectable` y `Logger` son lo único
 * que el adaptador usa): empaquetar Nest entero arrastraría `reflect-metadata` y `rxjs` para nada.
 * Los alias apuntan al ARCHIVO, no al barril: el barril de platform-core trae media API.
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
