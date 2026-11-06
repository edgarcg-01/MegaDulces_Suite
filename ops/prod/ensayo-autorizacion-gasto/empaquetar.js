#!/usr/bin/env node
/**
 * `[PGP.79]` Empaqueta `ensayo.ts` —con el adaptador REAL, `pg` y nada más— en UN archivo `.cjs`
 * que corre con `node` pelón dentro de un contenedor en `md`. Mismo molde que
 * `ops/prod/ensayo-pago-kepler/empaquetar.js` (ver su `README.md`).
 *
 *   node ops/prod/ensayo-autorizacion-gasto/empaquetar.js <salida.cjs>
 *
 * Y en `md`, una sucursal por corrida (la conexión entra por stdin, nunca en la línea de comandos):
 *
 *   { echo "$KEPLER_PUSH_URL_00"; echo 00; } | ssh superoot@192.168.0.222 \
 *     'docker run --rm -i --network host -v /tmp/ensayo-pgp79.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs'
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
