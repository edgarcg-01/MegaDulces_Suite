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
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW_RUNTIME });

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USER_A = '00000000-0000-0000-0000-0000000000aa';
let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
const setCtx = (trx) => trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
async function expectFail(fn) { try { await fn(); return false; } catch { return true; } }

// Mirror de recordCount: expected = stock, window_from = último conteo (o inicio).
async function recordCount(trx, mon, physical) {
  const stock = await trx('commercial.stock').where({ warehouse_id: mon.warehouse_id, product_id: mon.product_id }).first('quantity');
  const expected = stock ? Number(stock.quantity) : 0;
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
      const wh = await trx('commercial.warehouses').where({ code: 'MON-TEST-WH' }).first();
      whId = wh ? wh.id : (await trx('commercial.warehouses').insert({ tenant_id: TENANT, code: 'MON-TEST-WH', name: 'Monitoreo Test WH' }).returning('id'))[0].id;
      prod = (await trx('catalog.products').where({ tenant_id: TENANT }).first('id')).id;
      await trx('commercial.inventory_monitoring').where({ warehouse_id: whId }).del();
      const st = await trx('commercial.stock').where({ warehouse_id: whId, product_id: prod }).first('id');
      if (st) await trx('commercial.stock').where({ id: st.id }).update({ quantity: 114 });
      else await trx('commercial.stock').insert({ tenant_id: TENANT, warehouse_id: whId, product_id: prod, quantity: 114, reserved_quantity: 0 });
    });
    check(!!whId && !!prod, 'setup: almacén + producto + stock 114');

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
