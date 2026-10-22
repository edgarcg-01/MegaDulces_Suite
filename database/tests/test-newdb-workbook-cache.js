/* eslint-disable no-console */
/**
 * `[RA-UX.11b]` EL CACHÉ DEL WORKBOOK — servicio REAL vía ts-node, SÓLO LECTURA.
 *
 * ── Por qué existe, medido en prod el 2026-10-22 ────────────────────────────────────────────
 *
 * La consulta principal de `/compras/pedido` tarda 2.2–2.9 s y no baja retocándola (5 variantes:
 * mismo resultado, mismo tiempo dentro del ruido). Recalcula los 5,626 productos en CADA filtro y
 * en CADA página. Se cachea 60 s lo pesado (filas + totales + sucursales); las señales («ya
 * requisado», margen, venta perdida) y la frescura se calculan SIEMPRE.
 *
 * Lo que defiende, cada cosa con su caso:
 *   0. ARRANQUE: `design:paramtypes` del servicio nombra a `TenantCacheService` en la posición
 *      nueva (la lección de #414: un regex sobre el fuente no lo prueba; Nest lee la metadata).
 *   1. La segunda llamada igual NO repite la consulta pesada, y devuelve lo MISMO.
 *   2. NEGATIVA: otro alcance de sucursales (lo que ve otra persona) NO sale del caché del primero.
 *   3. NEGATIVA: la exportación no toca el caché.
 *   4. Sin caché (proveedor ausente) la pantalla responde igual que con él.
 * El caché de la prueba es un Map en memoria con el mismo contrato que `TenantCacheService`.
 * Sin datos en la base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

let Servicio, TenantCacheService;
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
  ({ TenantCacheService } = require('@megadulces/platform-core'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
let pesadas = 0;
// La consulta pesada es la que ordena por venta: es la única con ese ORDER BY.
knex.on('query', (q) => { if (/ORDER BY valor_venta DESC NULLS LAST, sku LIMIT/.test(String(q.sql))) pesadas++; });

function memoria() {
  const m = new Map();
  return { m, getOrSet: async (k, _ttl, prod) => { if (m.has(k)) return m.get(k); const v = await prod(); m.set(k, v); return v; } };
}
function servicio(cache, alcance = null) {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
    scope: { warehouseIds: async () => alcance },
    cache,
    tk: { run: (fn) => knex.transaction(async (trx) => {
      await trx.raw('SET TRANSACTION READ ONLY');
      await trx.raw('SET LOCAL statement_timeout = 120000');
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      return fn(trx);
    }) },
  });
  return s;
}
const sinVolatil = (r) => JSON.stringify({ ...r, freshness: undefined, rows: r.rows.map((x) => ({ ...x, signals: undefined })) });

(async () => {
  console.log('\n[RA-UX.11b] El caché del workbook — servicio real, sólo lectura\n');

  // 0. Arranque: la metadata que Nest usa para inyectar.
  const tipos = Reflect.getMetadata('design:paramtypes', Servicio) || [];
  console.log(`   design:paramtypes = [${tipos.map((t) => (t && t.name) || String(t)).join(', ')}]`);
  ok(tipos.length === 6 && tipos[5] === TenantCacheService, 'design:paramtypes[5] es TenantCacheService (Nest lo puede inyectar)');

  const Q = { coverage_days: 30, group: 'branch', page: 1, pageSize: 20 };
  const c = memoria();
  pesadas = 0;
  const t1 = Date.now(); const a = await servicio(c).workbook(Q); const ms1 = Date.now() - t1;
  const p1 = pesadas;
  if (!a.total) { noMedido('la base no trae plan de reabasto'); await knex.destroy(); return salir(); }
  const t2 = Date.now(); const b = await servicio(c).workbook(Q); const ms2 = Date.now() - t2;
  console.log(`   1ª llamada ${ms1} ms (${p1} consulta pesada) · 2ª ${ms2} ms (${pesadas - p1})`);
  ok(p1 === 1 && pesadas === 1, 'la 2ª llamada igual NO repite la consulta pesada');
  ok(sinVolatil(a) === sinVolatil(b), 'y devuelve lo MISMO (filas, totales, sucursales)');
  ok(b.rows.every((r) => 'signals' in r) && typeof b.freshness === 'object', 'las señales y la frescura se calculan en cada llamada, fuera del caché');

  // 2. Dos alcances del MISMO tamaño (sucursal A contra sucursal B): la SQL es idéntica y sólo
  //    cambian los parámetros. Si la llave no incluyera los parámetros, B saldría con lo de A.
  const sucs = (await knex.raw('SELECT w.id, w.code FROM commercial.warehouses w WHERE w.tenant_id = ? AND w.code = ANY(?) ORDER BY w.code LIMIT 2', [T, a.territories.map((t) => t.code)])).rows;
  if (sucs.length === 2) {
    const antes = pesadas;
    const A = await servicio(c, [sucs[0].id]).workbook(Q);
    const B = await servicio(c, [sucs[1].id]).workbook(Q);
    ok(pesadas === antes + 2, 'NEGATIVA: el alcance B (misma SQL, otro parámetro) NO sale del caché del alcance A');
    ok(A.territories.map((t) => t.code).join() === sucs[0].code && B.territories.map((t) => t.code).join() === sucs[1].code,
      `y cada uno ve SÓLO su sucursal (A=${A.territories.map((t) => t.code)}, B=${B.territories.map((t) => t.code)})`);
  } else noMedido('menos de dos sucursales: el alcance no se pudo ejercer');

  // 3. La exportación no toca el caché.
  const llaves = c.m.size; const antesExp = pesadas;
  await servicio(c).workbook({ ...Q, export: true, pageSize: 50 });
  ok(c.m.size === llaves && pesadas === antesExp + 1, 'NEGATIVA: la exportación no guarda ni lee caché');

  // 4. Sin caché, lo mismo.
  const sin = await servicio(undefined).workbook(Q);
  ok(sinVolatil(sin) === sinVolatil(a), 'sin caché (proveedor ausente) responde igual que con él');

  await knex.destroy();
  salir();
})().catch(async (e) => { console.error('  ✗', e.message); await knex.destroy(); process.exit(1); });
