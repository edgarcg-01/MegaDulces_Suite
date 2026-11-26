#!/usr/bin/env node
/**
 * `[GP.R.3]` Empaqueta `ensayo.ts` —con `reservarFolioKepler`, `clonarFila`/`insertarFila`, `pg` y nada más— en UN
 * archivo `.cjs` que corre con `node` pelón dentro de un contenedor en `md`. Mismo esquema que
 * `ops/prod/ensayo-autorizacion-kepler/empaquetar.js`.
 *
 *   node ops/prod/ensayo-cobro-kepler/empaquetar.js <salida.cjs>
 *
 * El `.cjs` **no lleva credenciales**: la URL entra por stdin.
 */
const path = require('node:path');
const esbuild = require('esbuild');

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
