/* eslint-disable no-console */
/**
 * `[RA-NEG.1]` COSTO Y NEGOCIACIÓN de un producto — servicio REAL vía ts-node, SÓLO LECTURA.
 *
 * El panel de `/compras/pedido` lee lo pagado con dos pasos (renglones por SKU y encabezado por
 * documento con LATERAL) para no barrer los ~514 mil `X-A-20`. Un atajo así puede perder o duplicar
 * filas sin que nada lo diga, así que se cruza contra un TESTIGO: el JOIN directo encabezado↔renglón
 * que usa `StandardCostService.historial`, con la misma regla de duplicados.
 *
 *   0. ARRANQUE: `design:paramtypes` = [TenantKnexService, TenantContextService, TenantCacheService].
 *   1. Lo pagado (renglones y dinero) coincide con el testigo, al centavo.
 *   2. Lo que publica el costo es lo que dice `v_kepler_standard_cost` (no se recalcula).
 *   3. Con caché, la segunda llamada NO vuelve a leer `kdm2`, y responde lo mismo.
 *   4. NEGATIVA: un id que no es un producto da 404, no un panel vacío.
 * Sin compras en la base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = async (knex) => { if (knex) await knex.destroy(); console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

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
  ({ PedidoNegociacionService: Servicio } = require(path.join(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/pedido-negociacion.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
let lecturasKdm2 = 0;
knex.on('query', (q) => { if (/FROM kepler_ods\.kdm2 l\s+WHERE btrim\(l\.c8\)/.test(String(q.sql))) lecturasKdm2++; });

const tk = { run: (fn) => knex.transaction(async (trx) => {
  await trx.raw('SET TRANSACTION READ ONLY');
  await trx.raw('SET LOCAL statement_timeout = 120000');
  await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
  return fn(trx);
}) };
function servicio(cache) {
  return Object.assign(Object.create(Servicio.prototype), { tk, tenantCtx: { requireTenantId: () => T }, cache, logger: { log() {}, warn() {}, error() {} } });
}
function memoria() {
  const m = new Map();
  return { getOrSet: async (k, _t, prod) => { if (m.has(k)) return m.get(k); const v = await prod(); m.set(k, v); return v; } };
}
/** TESTIGO: el JOIN directo encabezado↔renglón (el de StandardCostService.historial), con la misma regla de duplicados. */
async function testigo(sku, supCode, desde) {
  return (await knex.raw(
    `SELECT count(*)::int AS renglones, COALESCE(sum(${NUM('l.c9')} * ${NUM('l.c12')}), 0)::numeric AS valor
       FROM kepler_ods.kdm2 l
       JOIN kepler_ods.kdm1 ap ON ap.sucursal = l.sucursal AND ap.c1 = l.c1 AND ap.c2 = l.c2 AND ap.c3 = l.c3 AND ap.c4 = l.c4 AND ap.c6 = l.c6
      WHERE btrim(l.c8) = ? AND l.c2 = 'X' AND l.c3 = 'A' AND btrim(l.c4::text) = '20'
        AND btrim(ap.c1::text) = ap.sucursal::text AND btrim(coalesce(ap.c43::text, '')) <> 'C'
        AND ap.c68::date >= ?::date AND btrim(ap.c10::text) = ?
        AND NOT EXISTS (SELECT 1 FROM analytics.erp_goods_receipt_dedup dd
                         WHERE ap.sucursal = '00' AND dd.cedis_folio = btrim(ap.c6) AND dd.status IN ('auto', 'confirmado'))`,
    [sku, desde, supCode])).rows[0];
}

const NUM = (col) => `nullif(regexp_replace(${col}::text, '[^0-9.-]', '', 'g'), '')::numeric`;

(async () => {
  console.log('\n[RA-NEG.1] Costo y negociación — servicio real, sólo lectura\n');

  const tipos = (Reflect.getMetadata('design:paramtypes', Servicio) || []).map((t) => (t && t.name) || String(t));
  console.log(`   design:paramtypes = [${tipos.join(', ')}]`);
  ok(tipos.join(',') === 'TenantKnexService,TenantContextService,TenantCacheService', '0. Nest conoce las tres dependencias del constructor (lección de #414)');

  // Un producto con compras recientes a SU proveedor de catálogo.
  let cand;
  try {
    cand = (await knex.raw(
      `SELECT p.id, p.sku, s.code AS sup_code
         FROM catalog.products p JOIN catalog.suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND s.code IS NOT NULL
          AND EXISTS (SELECT 1 FROM kepler_ods.kdm1 ap
                       WHERE ap.c2 = 'X' AND ap.c3 = 'A' AND btrim(ap.c4::text) = '20' AND btrim(ap.c10::text) = s.code
                         AND ap.c68::date >= current_date - 60
                         AND EXISTS (SELECT 1 FROM kepler_ods.kdm2 l WHERE l.sucursal = ap.sucursal AND l.c1 = ap.c1 AND l.c2 = 'X'
                                       AND l.c3 = 'A' AND l.c4 = ap.c4 AND l.c6 = ap.c6 AND btrim(l.c8) = p.sku))
        ORDER BY p.sku LIMIT 4`, [T])).rows;
  } catch (e) {
    noMedido(`no se pudo buscar un producto con compras (${e.message.split('\n')[0]})`);
    return salir(knex);
  }
  if (!cand.length) { noMedido('la base no tiene compras X-A-20 de los últimos 60 días a un proveedor de catálogo'); return salir(knex); }
  // El dinero sólo se compara en un producto sin renglones excluidos a propósito (unidad desconocida o atípicos):
  // se prueban hasta 4 y se usa el primero limpio; los conteos se exigen en TODOS.
  let medidoDinero = false;
  for (const c of cand) {
    const dd = await servicio(null).negociacion(c.id);
    const tt = await testigo(c.sku, c.sup_code, dd.pagado.desde);
    ok(dd.pagado.renglones === tt.renglones, `1a. ${c.sku}: renglones servicio ${dd.pagado.renglones} = testigo ${tt.renglones}`);
    if (!medidoDinero && dd.pagado.renglones_sin_unidad + dd.pagado.renglones_atipicos === 0 && tt.renglones > 0) {
      medidoDinero = true;
      ok(Math.abs(dd.pagado.total_valor - Number(tt.valor)) < 0.05, `1b. ${c.sku}: dinero servicio ${dd.pagado.total_valor} = testigo ${Number(tt.valor).toFixed(2)}`);
    }
  }
  if (!medidoDinero) noMedido('1b. dinero: los 4 productos traen renglones excluidos a propósito; el testigo no los separa');
  cand = cand[0];
  console.log(`   producto ${cand.sku} · proveedor ${cand.sup_code}`);

  const s = servicio(memoria());
  const d = await s.negociacion(cand.id);

  // 2. El costo es el de la vista, sin recalcular.
  const v = (await knex.raw(`SELECT precio_ficha, venta_neta_30d FROM analytics.v_kepler_standard_cost WHERE sku = ? ORDER BY venta_neta_30d DESC NULLS LAST LIMIT 1`, [cand.sku])).rows[0];
  if (v && v.precio_ficha != null) ok(Number(v.precio_ficha) === d.costo.precio_ficha, `2. precio de ficha = el de v_kepler_standard_cost (${v.precio_ficha})`);
  else noMedido('2. el producto no tiene ficha con precio');

  // 3. Caché: la segunda llamada no vuelve a leer kdm2.
  const antes = lecturasKdm2;
  const d2 = await s.negociacion(cand.id);
  ok(lecturasKdm2 === antes, `3a. la segunda llamada no relee kdm2 (${lecturasKdm2 - antes} lecturas)`);
  ok(JSON.stringify({ ...d2, generado_at: 0 }) === JSON.stringify({ ...d, generado_at: 0 }), '3b. y responde lo mismo');

  // 4. NEGATIVA: un id que no es un producto.
  let st = null;
  try { await s.negociacion('00000000-0000-0000-0000-000000000000'); } catch (e) { st = e.status ?? e.getStatus?.(); }
  ok(st === 404, `4. un producto que no existe da 404 (dio ${st})`);

  return salir(knex);
})().catch(async (e) => { console.error('  ✗ ERROR', e.message); fail++; await salir(knex); });
