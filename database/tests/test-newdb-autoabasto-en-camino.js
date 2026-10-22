/* eslint-disable no-console */
/**
 * `[AB.23]`–`[AB.24]` «MI PEDIDO» RESTA LO QUE YA VIENE — servicio REAL vía ts-node, SÓLO LECTURA.
 *
 * Al embarcarse un pedido de traspaso dejaba de contar como «ya pedido», y la existencia de la
 * sucursal no sube hasta la recepción: en ese lapso (mediana 1 día, p90 4) el encargado volvía a
 * pedirlo. Medido 2026-10-22: 88 embarques, $1.54 M en camino; $424,600 menos de pedido duplicado.
 *
 *   0. ARRANQUE: el servicio carga con su constructor.
 *   1. La cuenta de cada renglón cierra: falta_neta = max(0, falta − ya_pedido − en_camino).
 *   2. TESTIGO de documentos: los embarques sin recibir que el servicio resta son los que cuenta
 *      una consulta escrita aparte sobre `analytics.erp_shipment_lines` (otra vía que el servicio).
 *   3. TESTIGO de productos: cada producto de la mesa que el testigo ve en camino, el servicio lo resta.
 *   4. Lo planeado por Compras (`[AB.24]`) coincide con las requisiciones de la base y NUNCA se resta.
 *   5. NEGATIVA: en una sucursal sin nada en camino, nada se resta por «en camino».
 * Sin embarques en la base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
let knex;
const salir = async () => { if (knex) await knex.destroy(); console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

let Motor, Pedido;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  const L = path.join(__dirname, '../../libs/commercial/src/lib/commercial-replenishment/');
  ({ CommercialReplenishmentService: Motor } = require(L + 'commercial-replenishment.service.ts'));
  ({ AutoabastoPedidoService: Pedido } = require(L + 'autoabasto-pedido.service.ts'));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

knex = require('knex')(require('../knexfile-newdb.js').development);
const tk = { run: (fn) => knex.transaction(async (trx) => {
  await trx.raw('SET TRANSACTION READ ONLY');
  await trx.raw('SET LOCAL statement_timeout = 120000');
  await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
  return fn(trx);
}) };
const ctx = { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) };
const motor = Object.assign(Object.create(Motor.prototype), { tk, tenantCtx: ctx, logger: { log() {}, warn() {}, error() {}, debug() {} },
  scope: { warehouseIds: async (q) => (q && q.warehouse_id ? [q.warehouse_id] : null) } });
const svc = Object.assign(Object.create(Pedido.prototype), { motor, tk, tenantCtx: ctx });

/** TESTIGO: embarques (U-D-41) a la sucursal, de 7 días o menos, sin su recepción (U-A-50), con renglones de la vista. */
async function testigo(suc) {
  return (await knex.raw(`
    WITH dest AS (SELECT dest_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = ? AND suc_code = ?),
    emb AS (
      SELECT btrim(h.sucursal) AS origen, (h.c5)::int AS serie, btrim(h.c6::text) AS folio
        FROM kepler_ods.kdm1 h
       WHERE h.c2 = 'U' AND h.c3 = 'D' AND (h.c4)::int = 41 AND btrim(h.c1) = btrim(h.sucursal)
         AND btrim(COALESCE(h.c43, '')) <> 'C' AND h.c9::date >= current_date - 7
         AND btrim(h.c10::text) IN (SELECT dest_code FROM dest)
         AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 x
                          WHERE x.c2 = 'U' AND x.c3 = 'A' AND (x.c4)::int = 50 AND btrim(x.sucursal) = ? AND btrim(x.c1) = ?
                            AND x.c37 = 41 AND x.c38 = h.c5 AND btrim(x.c39::text) = btrim(h.c6::text)
                            AND btrim(COALESCE(x.c43, '')) <> 'C' AND x.c9::date >= h.c9::date - 1))
    SELECT e.origen, e.serie, e.folio, l.sku, l.cantidad
      FROM emb e
      LEFT JOIN analytics.erp_shipment_lines l ON l.tenant_id = ? AND l.sucursal = e.origen AND l.serie = e.serie AND l.folio = e.folio`,
    [T, suc, suc, suc, T])).rows;
}

(async () => {
  console.log('\n[AB.23] «Mi pedido» resta lo que ya viene — servicio real, sólo lectura\n');
  ok(Pedido.length === 3, `0. el servicio toma sus tres dependencias (${Pedido.length})`);

  const whs = (await knex.raw(`SELECT w.id, w.code, w.name FROM commercial.warehouses w
      JOIN analytics.v_erp_branch_catalog b ON b.tenant_id = w.tenant_id AND b.suc_code = w.code
     WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.code <> '00' ORDER BY w.code`, [T]).catch(() => ({ rows: [] }))).rows;
  if (!whs.length) { noMedido('la base no tiene sucursales con cliente de traspaso'); return salir(); }
  const conteo = [];
  for (const w of whs) {
    const t = await testigo(w.code);
    conteo.push({ w, t, docs: new Set(t.map((x) => `${x.origen}|${x.serie}|${x.folio}`)).size });
  }
  conteo.sort((a, b) => b.docs - a.docs);
  const con = conteo[0], sin = conteo.find((x) => x.docs === 0);
  if (!con.docs) { noMedido('ninguna sucursal tiene embarques sin recibir en los últimos 7 días'); return salir(); }
  console.log(`   con más en camino: ${con.w.name} (${con.docs} embarques) · sin nada: ${sin ? sin.w.name : '—'}`);

  const r = await svc.pedido({ id: con.w.id, code: con.w.code, name: con.w.name }, 'almacen', false);
  const lineas = r.grupos.flatMap((g) => g.lineas);

  // 1 · La cuenta cierra en cada renglón (al redondeo de 0.1 de las cajas).
  const malas = lineas.filter((l) => Math.abs(l.falta_neta - Math.max(0, l.falta - l.ya_pedido - l.en_camino)) > 0.2);
  ok(malas.length === 0, `1. falta_neta = max(0, falta − ya_pedido − en_camino) en los ${lineas.length} renglones (${malas.length} no cierran)`);

  // 2 · Documentos: los que se restan = los del testigo.
  const emb = (r.viene?.documentos || []).filter((d) => d.tipo === 'embarque' && d.se_resta);
  ok(emb.length === con.docs, `2. embarques que se restan: servicio ${emb.length} = testigo ${con.docs}`);

  // 3 · Productos: lo que el testigo ve en camino (y está en la mesa), el servicio lo resta.
  const enMesa = new Set(lineas.map((l) => l.sku));
  const skusT = new Set(con.t.filter((x) => x.sku && Number(x.cantidad) > 0 && enMesa.has(x.sku)).map((x) => x.sku));
  const restados = new Set(lineas.filter((l) => l.en_camino > 0).map((l) => l.sku));
  const faltan = [...skusT].filter((s) => !restados.has(s));
  const sobran = [...restados].filter((s) => !skusT.has(s));
  if (faltan.length) console.log('     faltan:', JSON.stringify(faltan.map((s) => ({ sku: s, testigo: con.t.filter((x) => x.sku === s), linea: lineas.find((l) => l.sku === s) }))).slice(0, 900), '· sin unidad:', r.viene?.renglones_sin_unidad);
  ok(skusT.size > 0 && faltan.length === 0 && sobran.length === 0,
    `3. productos en camino: testigo ${skusT.size} · servicio ${restados.size} · le faltan ${faltan.length} · le sobran ${sobran.length}`);

  // 4 · Lo planeado por Compras: lo de la base, y nunca se resta.
  const planBase = (await knex.raw(`SELECT count(DISTINCT r.id)::int AS n FROM commercial.purchase_requisitions r
      JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND COALESCE(l.final_qty, 0) > 0
     WHERE r.tenant_id = ? AND r.warehouse_id = ? AND r.source_type = 'branch' AND r.estado IN ('pending_approval', 'approved')
       AND r.kepler_folio IS NULL AND r.created_at >= now() - interval '7 days'`, [T, con.w.id])).rows[0].n;
  const planes = (r.viene?.documentos || []).filter((d) => d.tipo === 'plan');
  if (planBase) {
    ok(planes.length === planBase && planes.every((d) => !d.se_resta), `4. lo planeado por Compras: ${planes.length} = base ${planBase}, ninguno se resta`);
  } else noMedido('4. la sucursal no tiene requisiciones de traspaso recientes');

  // 5 · NEGATIVA: sin nada en camino, nada se resta por «en camino».
  if (sin) {
    const r2 = await svc.pedido({ id: sin.w.id, code: sin.w.code, name: sin.w.name }, 'almacen', false);
    const n = r2.grupos.flatMap((g) => g.lineas).filter((l) => l.en_camino > 0).length;
    ok(n === 0, `5. ${sin.w.name}, sin embarques sin recibir: ${n} renglones con «en camino»`);
  } else noMedido('5. todas las sucursales tienen algo en camino');

  return salir();
})().catch(async (e) => { console.error('  ✗ ERROR', e.message); fail++; await salir(); });
