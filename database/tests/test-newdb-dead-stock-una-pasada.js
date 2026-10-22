/* eslint-disable no-console */
/**
 * `[RA-UX.11]` STOCK MUERTO EN UNA PASADA — servicio REAL vía ts-node, SÓLO LECTURA.
 *
 * ── Por qué existe, medido en prod el 2026-10-22 ────────────────────────────────────────────
 *
 * `deadStock()` hacía TRES consultas sobre la misma base —conteo, suma y filas—, cada una pagando
 * entero el cruce producto×almacén y las tres vistas del ODS: 4.1 + 4.2 + 6.5 s = 14.9 s (13.0 s
 * en el navegador). Ahora el total y la suma salen de la consulta de filas con `OVER ()`.
 * Antes/después contra prod: mismo total (53,233), misma suma ($1,399,720.61), mismo conjunto y
 * contenido de las páginas 1 y 2; el orden sólo cambia dentro de empates, por el desempate nuevo.
 *
 * Lo que defiende:
 *   1. UNA consulta por página (si vuelve a haber tres, vuelve el costo).
 *   2. DOS caminos, mismo número: el total por ventana (página con filas) contra el total por
 *      agregado (página después del final, que no trae filas y cuenta aparte). Si divergen, uno
 *      de los dos está mal — y una sola implementación no lo podría ver.
 *   3. Páginas 1 y 2 no comparten renglones (el desempate estable).
 *   4. Las columnas auxiliares de la ventana NO viajan en la respuesta.
 * Sin datos (base vacía): NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

let Servicio;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ CommercialReplenishmentService: Servicio } = require(path.join(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
let consultas = 0;
// Sólo las consultas del servicio: BEGIN/COMMIT y el SET del arnés no cuentan.
knex.on('query', (q) => { if (!/^(BEGIN|COMMIT|ROLLBACK|SET|SELECT set_config)/i.test(String(q.sql).trim())) consultas++; });

function servicio() {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
    scope: { warehouseIds: async () => null },
    tk: { run: (fn) => knex.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw('SET LOCAL statement_timeout = 120000');
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      return fn(trx);
    }) },
  });
  return s;
}

(async () => {
  console.log('\n[RA-UX.11] Stock muerto en una pasada — servicio real, sólo lectura\n');
  const s = servicio();
  const tam = 50;
  consultas = 0;
  const p1 = await s.deadStock({ pageSize: tam, page: 1 });
  const nP1 = consultas;
  if (!p1.total) { noMedido('la base no trae productos sin política con almacén gestionado'); await knex.destroy(); return salir(); }
  console.log(`   total ${p1.total} · inmovilizado ${p1.total_value} · ${nP1} consulta(s) en la página 1`);
  ok(nP1 === 1, `la página 1 es UNA consulta (fueron ${nP1}; antes eran 3)`);
  ok(p1.rows.every((r) => !('_total' in r) && !('_total_value' in r)), 'las columnas auxiliares de la ventana no viajan en la respuesta');

  const ultima = Math.ceil(p1.total / tam) + 1;
  const fuera = await s.deadStock({ pageSize: tam, page: ultima });
  ok(fuera.rows.length === 0, `la página ${ultima} (después del final) viene vacía`);
  ok(fuera.total === p1.total, `DOS CAMINOS, mismo total: ventana ${p1.total} = agregado ${fuera.total}`);
  ok(Math.abs(fuera.total_value - p1.total_value) < 0.01, `DOS CAMINOS, misma suma: ventana ${p1.total_value} = agregado ${fuera.total_value}`);

  if (p1.total > tam) {
    const p2 = await s.deadStock({ pageSize: tam, page: 2 });
    const k = (r) => r.product_id + '|' + r.warehouse_id;
    const enP1 = new Set(p1.rows.map(k));
    const rep = p2.rows.filter((r) => enP1.has(k(r))).length;
    ok(rep === 0, `las páginas 1 y 2 no comparten renglones (repetidos: ${rep})`);
    ok(p2.total === p1.total, 'la página 2 publica el mismo total que la 1');
  } else noMedido('una sola página: el desempate entre páginas no se ejerció');

  await knex.destroy();
  salir();
})().catch(async (e) => { console.error('  ✗', e.message); await knex.destroy(); process.exit(1); });
