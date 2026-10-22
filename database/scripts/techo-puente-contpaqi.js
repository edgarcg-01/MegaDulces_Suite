#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.48]` — **El techo del puente: cuánto arma solo y quién destraba el resto.**
 *
 * `[CP.8.45]` §39.1 midió esto sobre 8 meses (15,599 egresos, 6.1 % arma solo) y la consulta no
 * quedó en el repo, así que nadie podía repetirla para el antes/después. Este script la repite con
 * **el mismo camino que la bandeja** (`ContpaqiArmadoService.simularLotes`): si la pantalla y la
 * medición usaran dos armados distintos, la cifra podría no ser la que contabilidad ve.
 *
 *   node database/scripts/techo-puente-contpaqi.js --desde=2026-01 --hasta=2026-08
 *
 * Sólo lectura: la sesión se abre con `default_transaction_read_only = on`.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
// Mismo truco que `test-newdb-contpaqi-bandeja.js`: sin el tsconfig del monorepo no hay alias.
const ALIAS = {
  '@megadulces/contracts': path.join(ROOT, 'libs/contracts/src/index.ts'),
  '@megadulces/platform-core': path.join(ROOT, 'libs/platform-core/src/index.ts'),
};
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(pedido, ...resto) {
  return ALIAS[pedido] ? ALIAS[pedido] : resolveOriginal.call(this, pedido, ...resto);
};
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const { ContpaqiArmadoService } = require(path.join(ROOT, 'libs/finance/src/lib/contpaqi/contpaqi-armado.service.ts'));

const arg = (n, d) => {
  const p = process.argv.find((a) => a.startsWith(`--${n}=`));
  return p ? p.split('=').slice(1).join('=') : d;
};
const DESDE = arg('desde', '2026-01');
const HASTA = arg('hasta', DESDE);

function meses(desde, hasta) {
  const out = [];
  let [y, m] = desde.split('-').map(Number);
  const [yh, mh] = hasta.split('-').map(Number);
  while (y < yh || (y === yh && m <= mh)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

(async () => {
  const knex = require('knex')({
    client: 'pg', connection: process.env.DATABASE_URL_NEW,
    pool: {
      min: 0, max: 2,
      afterCreate: (conn, done) => conn.query('SET default_transaction_read_only = on', (e) => done(e, conn)),
    },
  });
  const sid = (await knex.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  const svc = new ContpaqiArmadoService(knex);
  // El servicio loguea un renglón por mes con Logger de Nest; acá estorba.
  svc.log = { log() {}, warn() {}, error() {} };

  let arma = 0; let armaImp = 0; let fuera = 0; let fueraImp = 0;
  const motivos = {};
  for (const mes of meses(DESDE, HASTA)) {
    const r = await svc.simularLotes(mes);
    for (const l of r.lotes) {
      arma += l.incluidas;
      armaImp += l.total;
      for (const [k, n] of Object.entries(l.motivos)) motivos[k] = (motivos[k] ?? 0) + n;
    }
    fuera += r.fuera_de_lote.movimientos;
    fueraImp += r.fuera_de_lote.importe;
  }
  const total = arma + fuera + Object.values(motivos).reduce((a, n) => a + n, 0);
  const pct = (n) => `${((n / total) * 100).toFixed(1)} %`.padStart(7);
  const fila = (k, n, extra = '') => console.log(`  ${k.padEnd(24)} ${String(n).padStart(6)} ${pct(n)}  ${extra}`);

  console.log(`\n[CP.8.48] techo del puente · ${DESDE} → ${HASTA} · system_identifier ${sid}`);
  console.log(`  universo: ${total} egresos\n`);
  fila('arma solo', arma, `$${(armaImp / 1e6).toFixed(1)}M`);
  for (const [k, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) fila(k, n);
  fila('fuera del puente', fuera, `$${(fueraImp / 1e6).toFixed(1)}M (no son bancos)`);
  console.log('');
  await knex.destroy();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
