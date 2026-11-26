/* eslint-disable no-console */
/**
 * Smoke DB-directo — Monitoreo intensivo + ventanas de pérdida (Fase PREV.2, Apéndice B).
 *
 *   1. Tablas existen con RLS forzado
 *   2. Iniciar monitoreo + guard "1 activo por (almacén,producto)"
 *   3. Conteo rápido: expected = stock del sistema, difference = físico − expected
 *   4. Ventana: 1er conteo window_from = inicio; 2º conteo window_from = conteo previo
 *   5. Ventana de pérdida: físico cae vs expected → faltante acotado a la ventana
 *   6. Cerrar monitoreo
 *
 * Almacén dedicado (MON-TEST-WH). Cada insert que viola constraint va en su propia tx.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
// `[IDG.1]` Este test BORRA filas (incluido `commercial.stock`). No puede correr contra prod.
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-inventory-monitoring');
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW_RUNTIME });

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USER_A = '00000000-0000-0000-0000-0000000000aa';
/** `[CANON.7.4d]` La clave de Kepler del almacén de prueba: la existencia sale del ODS y se une por ella. */
const SUC_TEST = '95';
let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
const setCtx = (trx) => trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
async function expectFail(fn) { try { await fn(); return false; } catch { return true; } }

// Mirror de recordCount: expected = existencia del ODS, window_from = último conteo (o inicio).
//
// ⚠️ `[CANON.7.4d]` ESTO ES UN MIRROR, no el servicio: lo que fija de verdad el camino que ESCRIBE es
// `libs/commercial/src/lib/commercial-inventory/inventory-monitoring.it.spec.ts`, que ejerce
// `InventoryMonitoringService.recordCount` como `app_runtime` con la copia mintiendo a propósito. Este archivo
// cubre lo que aquél no: el esquema, el RLS forzado, el guard de «1 activo por (almacén, producto)» y las
// ventanas. Se actualizó el 2026-11-25 porque seguía describiendo la forma vieja —leer `commercial.stock`—, y
// una prueba verde que describe lo que ya no existe es peor que no tenerla.
async function recordCount(trx, mon, physical) {
  const { rows } = await trx.raw(
    `SELECT COALESCE(sum(e.qty_stock_units), 0)::float8 AS q
       FROM analytics.v_erp_stock_on_hand e
      WHERE e.warehouse_id = ?::uuid AND e.product_id = ?::uuid`,
    [mon.warehouse_id, mon.product_id],
  );
  const expected = Number(rows[0]?.q) || 0;
  const prev = await trx('commercial.inventory_monitoring_counts').where({ monitoring_id: mon.id }).orderBy('counted_at', 'desc').first('counted_at');
  const windowFrom = prev ? prev.counted_at : mon.started_at;
  const [row] = await trx('commercial.inventory_monitoring_counts').insert({
    tenant_id: TENANT, monitoring_id: mon.id, expected_qty: expected, physical_qty: physical,
    difference: physical - expected, window_from: windowFrom, window_to: trx.fn.now(), counted_at: trx.fn.now(), counted_by: USER_A,
  }).returning('*');
  return row;
}

(async () => {
  let whId, prod, monId;
  try {
    // ── 1. Schema + RLS ──
    console.log('\n1) Schema + RLS');
    for (const t of ['inventory_monitoring', 'inventory_monitoring_counts']) {
      const reg = await knex.raw(`SELECT to_regclass('commercial.${t}') AS r`);
      check(reg.rows[0].r, `commercial.${t} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'commercial.${t}'::regclass`);
      check(rls.rows[0]?.relforcerowsecurity === true, `commercial.${t} tiene RLS forzado`);
    }

    // Setup: almacén + producto + stock 114
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      // `[CANON.7.4d]` El almacén necesita `kepler_code`: la existencia sale del ODS, que une por la clave
      // de Kepler y el `sku` del producto. Sin eso la vista no tiene renglón y el teórico sería 0.
      const wh = await trx('commercial.warehouses').where({ code: 'MON-TEST-WH' }).first();
      whId = wh ? wh.id : (await trx('commercial.warehouses').insert({ tenant_id: TENANT, code: 'MON-TEST-WH', name: 'Monitoreo Test WH', kepler_code: SUC_TEST }).returning('id'))[0].id;
      if (wh && wh.kepler_code !== SUC_TEST) await trx('commercial.warehouses').where({ id: whId }).update({ kepler_code: SUC_TEST });
      const p = await trx('catalog.products').where({ tenant_id: TENANT }).whereNotNull('sku').first('id', 'sku');
      prod = p.id;
      await trx('commercial.inventory_monitoring').where({ warehouse_id: whId }).del();
      // Kepler dice 114. La copia dice 999: es el CONTROL — si algo volviera a leerla, el teórico sería 999.
      await trx.raw(`DELETE FROM kepler_ods.kdil WHERE sucursal = ? AND btrim(c3) = ?`, [SUC_TEST, p.sku]);
      await trx.raw(
        `INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9, c6, c7) VALUES (?, ?, 0, ?, 114, 0, 0, now(), now())`,
        [SUC_TEST, SUC_TEST, p.sku],
      );
      const st = await trx('commercial.stock').where({ warehouse_id: whId, product_id: prod }).first('id');
      if (st) await trx('commercial.stock').where({ id: st.id }).update({ quantity: 999 });
      else await trx('commercial.stock').insert({ tenant_id: TENANT, warehouse_id: whId, product_id: prod, quantity: 999, reserved_quantity: 0 });
    });
    check(!!whId && !!prod, 'setup: almacén con clave de Kepler + producto + existencia 114 en el ODS (y la copia en 999, de control)');

    // ── 2. Iniciar monitoreo + guard 1-activo ──
    console.log('\n2) Iniciar monitoreo + guard');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const [m] = await trx('commercial.inventory_monitoring').insert({
        tenant_id: TENANT, warehouse_id: whId, product_id: prod, status: 'active', counts_per_day: 2, reason: 'PNI test', started_by: USER_A,
      }).returning('*');
      monId = m.id;
      check(!!monId, 'monitoreo activo creado');
    });
    check(await expectFail(() => knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_monitoring').insert({ tenant_id: TENANT, warehouse_id: whId, product_id: prod, status: 'active' });
    })), '2º monitoreo activo para el mismo SKU rechazado (único parcial)');

    // ── 3+4+5. Conteos + ventanas + pérdida ──
    console.log('\n3) Conteos · 4) ventanas · 5) pérdida');
    let c1, c2;
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const mon = await trx('commercial.inventory_monitoring').where({ id: monId }).first();
      // Conteo 1: físico 114 == sistema 114 → diff 0
      c1 = await recordCount(trx, mon, 114);
      check(Number(c1.difference) === 0, `conteo 1: físico 114 == sistema 114 → diff 0 (fue ${c1.difference})`);
      check(new Date(c1.window_from).getTime() === new Date(mon.started_at).getTime(), 'conteo 1: window_from = inicio del monitoreo');
    });
    // pequeña pausa lógica: el 2º conteo en otra tx para timestamps distintos
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const mon = await trx('commercial.inventory_monitoring').where({ id: monId }).first();
      // Conteo 2: físico 107 (sistema sigue 114) → diff -7 (pérdida en la ventana c1→c2)
      c2 = await recordCount(trx, mon, 107);
      check(Number(c2.difference) === -7, `conteo 2: físico 107 vs sistema 114 → diff −7 (fue ${c2.difference})`);
      check(new Date(c2.window_from).getTime() === new Date(c1.counted_at).getTime(), 'conteo 2: window_from = conteo previo (ventana acotada)');
    });

    // counts_today = 2
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const r = await trx('commercial.inventory_monitoring_counts').where({ monitoring_id: monId }).whereRaw('counted_at::date = CURRENT_DATE').count('* as c').first();
      check(Number(r.c) === 2, `counts_today = 2 (fue ${r.c})`);
    });

    // ── 6. Cerrar ──
    console.log('\n6) Cerrar monitoreo');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_monitoring').where({ id: monId }).update({ status: 'closed', closed_at: trx.fn.now(), closed_by: USER_A });
      const m = await trx('commercial.inventory_monitoring').where({ id: monId }).first();
      check(m.status === 'closed', 'monitoreo cerrado');
    });
    // tras cerrar, se puede abrir uno nuevo (el índice parcial solo aplica a active)
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const [m2] = await trx('commercial.inventory_monitoring').insert({ tenant_id: TENANT, warehouse_id: whId, product_id: prod, status: 'active', started_by: USER_A }).returning('id');
      check(!!m2.id, 'tras cerrar, se abre un nuevo monitoreo activo');
    });

    // ── Cleanup ──
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.inventory_monitoring').where({ warehouse_id: whId }).del();
      await trx('commercial.stock').where({ warehouse_id: whId, product_id: prod }).del();
      // `[CANON.7.4d]` La existencia sembrada en el ODS también se retira: si quedara, el almacén `95` de
      // prueba seguiría apareciendo con 114 en cualquier lectura posterior de la vista.
      const p = await trx('catalog.products').where({ id: prod }).first('sku');
      if (p && p.sku) await trx.raw(`DELETE FROM kepler_ods.kdil WHERE sucursal = ? AND btrim(c3) = ?`, [SUC_TEST, p.sku]);
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} Monitoreo intensivo: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n💥 Error en el smoke:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
