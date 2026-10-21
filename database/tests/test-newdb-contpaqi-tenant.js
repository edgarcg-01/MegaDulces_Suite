/* eslint-disable no-console */
/**
 * `[CP.8.58]` — Candado de **el puente visto como lo ve la API**: sin tenant por default.
 *
 * ⛔⛔ Las siete tablas que lee el puente (`finance.bank_movements`, `bank_accounts`,
 * `movement_categories`, `contpaqi.account_rules`, `supplier_accounts`, `supplier_aliases`,
 * `poliza_exports`) tienen **RLS forzado** con `tenant_id = current_tenant_id()`. La API corre
 * como `app_runtime`, que **no** trae `app.tenant_id` por default. Los roles personales
 * (`edgar`, `david`, `francisco`, `sistemas`) **sí** lo traen (`pg_db_role_setting`).
 *
 * Por eso todo lo que se midió y se probó del puente —corrido como `edgar`— vio datos, y la API
 * habría visto **cero filas, sin error**: bandeja vacía, archivo «sin lotes», alias rechazado
 * por la política y un cuadre que juzga cero entregas para siempre. Es el mismo error de
 * medición que `[CP.8.44]` dejó escrito: *se midió con el rol equivocado*.
 *
 * Este candado borra el tenant de la SESIÓN (`SET app.tenant_id = ''`) para quedar como queda
 * `app_runtime`, y exige que los servicios fijen el tenant ellos mismos.
 *
 * ⚠️ Lo que NO prueba: que la API en prod efectivamente corra sin tenant. Eso se deriva del código
 * (`KNEX_NEW_DB` es un `knex(config)` pelado) y de `pg_db_role_setting`; no se ejerció como
 * `app_runtime`.
 *
 * Lee prod en SOLO LECTURA: cada sesión nace con `default_transaction_read_only = on`.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
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

const knexLib = require('knex');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'contpaqi');
let ok = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const silencio = { log() {}, warn() {}, error() {}, debug() {} };

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) {
    console.log('\n[NO MEDIDO] sin DATABASE_URL_NEW');
    console.log('\n✅ CP.8.58 el puente sin tenant: 0 ✓ / 0 ✗ · 1 NO MEDIDO\n');
    process.exit(0);
  }
  // ⭐ La sesión queda como `app_runtime`: sin tenant y sin poder escribir.
  const knex = knexLib({
    client: 'pg', connection: url,
    pool: {
      min: 0, max: 2,
      afterCreate: (conn, done) => conn.query(
        "SET default_transaction_read_only = on; SET app.tenant_id = ''", (e) => done(e, conn)),
    },
  });

  try {
    console.log('\n[1] El control: sin tenant, el RLS esconde todo (si no, este candado no prueba nada)');
    const n = async (t) => Number((await knex(t).count({ n: '*' }).first()).n);
    const crudo = await n('finance.bank_movements');
    check(crudo === 0, `finance.bank_movements sin tenant = ${crudo} filas (tiene que ser 0)`);
    const reglas = await n('contpaqi.account_rules');
    check(reglas === 0, `contpaqi.account_rules sin tenant = ${reglas} filas (tiene que ser 0)`);
    if (crudo !== 0) {
      console.log('  ⚠️ la sesión SÍ ve filas: el rol trae otro tenant o salta el RLS — el resto no mide nada');
    }

    console.log('\n[2] El armado fija el tenant él mismo');
    const { ContpaqiArmadoService } = require(path.join(SRC, 'contpaqi-armado.service.ts'));
    const svc = new ContpaqiArmadoService(knex, undefined);
    svc.log = silencio;
    const { lotes } = await svc.simularLotes('2026-01');
    check(lotes.length > 0, `simularLotes('2026-01') ve ${lotes.length} lotes (sin el arreglo: 0)`);
    const pend = await svc.proveedoresPendientes('2026-01');
    check(pend.length > 0, `proveedoresPendientes('2026-01') ve ${pend.length} nombres (sin el arreglo: 0)`);

    console.log('\n[3] El cuadre fija el tenant él mismo');
    const { ContpaqiCuadreService } = require(path.join(SRC, 'contpaqi-cuadre.service.ts'));
    const cu = new ContpaqiCuadreService(knex);
    cu.log = silencio;
    let err = null;
    try { await cu.estado(); } catch (e) { err = e; }
    check(err === null, `estado() corre sin tenant de sesión${err ? ` — ${err.message}` : ''}`);

    console.log('\n[4] ⛔ Fuera del alcance, el acceso LANZA — no devuelve vacío');
    let lanzo = null;
    try { await svc.db('contpaqi.account_rules').count(); } catch (e) { lanzo = e; }
    check(lanzo !== null && /CP\.8\.58/.test(String(lanzo.message)),
      `tocar \`db\` fuera de conTenant() lanza${lanzo ? `: «${String(lanzo.message).slice(0, 70)}…»` : ' — NO lanzó'}`);
  } finally {
    await knex.destroy();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8.58 el puente sin tenant: ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log(`  ✗ excepción: ${e && e.message}`);
  console.log(`\n❌ CP.8.58 el puente sin tenant: ${ok} ✓ / ${fail + 1} ✗\n`);
  process.exit(1);
});
