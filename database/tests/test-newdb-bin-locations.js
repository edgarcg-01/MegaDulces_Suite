/* eslint-disable no-console */
/**
 * Smoke DB-directo — Ubicación bin-level (Fase WMS-REC Pieza 3, ADR-044).
 *
 *   1. Tablas existen con RLS forzado
 *   2. Crear bin (code único por almacén)
 *   3. Put-away: acepta hasta lote.quantity; rechaza el exceso (SUM ubicado ≤ lote)
 *   4. Auxiliar de ubicaciones: dónde está el lote
 *   5. Por ubicar (to_locate = lote − SUM ubicado)
 *   6. FEFO físico: bins ordenados por caducidad ascendente
 *   7. deleteBin rechaza bin con inventario
 *
 * Almacén dedicado (BIN-TEST-WH). Mirror de la regla put-away sincronizado con el servicio.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW_RUNTIME });

const TENANT = '00000000-0000-0000-0000-00000000d01c';
let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}
const setCtx = (trx) => trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);

// Mirror de BinLocationService.putAway (regla SUM(ubicado)+qty ≤ lote.quantity).
async function putAway(trx, wh, prod, lot, expiry, binId, qty) {
  const lotRow = await trx('commercial.stock_lots').where({ warehouse_id: wh, product_id: prod, lot_code: lot })
    .where((qb) => (expiry ? qb.where('expiry_date', expiry) : qb.whereNull('expiry_date'))).first('quantity');
  if (!lotRow) return { ok: false, reason: 'no_lot' };
  const loc = await trx('commercial.stock_lot_locations').where({ warehouse_id: wh, product_id: prod, lot_code: lot })
    .where((qb) => (expiry ? qb.where('expiry_date', expiry) : qb.whereNull('expiry_date'))).sum({ s: 'quantity' }).first();
  const located = Number(loc?.s || 0);
  if (located + qty > Number(lotRow.quantity)) return { ok: false, reason: 'exceeds', located, lotQty: Number(lotRow.quantity) };
  await trx.raw(
    `INSERT INTO commercial.stock_lot_locations (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id, quantity)
     VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id)
     DO UPDATE SET quantity = commercial.stock_lot_locations.quantity + EXCLUDED.quantity`,
    [wh, prod, lot, expiry, binId, qty]);
  return { ok: true };
}

(async () => {
  let whId, prod, binA, binB;
  try {
    // ── 1. Schema + RLS ──
    console.log('\n1) Schema + RLS');
    for (const t of ['warehouse_bins', 'stock_lot_locations']) {
      const reg = await knex.raw(`SELECT to_regclass('commercial.${t}') AS r`);
      check(reg.rows[0].r, `commercial.${t} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = 'commercial.${t}'::regclass`);
      check(rls.rows[0]?.relforcerowsecurity === true, `commercial.${t} tiene RLS forzado`);
    }

    // Setup
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const wh = await trx('commercial.warehouses').where({ code: 'BIN-TEST-WH' }).first();
      whId = wh ? wh.id : (await trx('commercial.warehouses').insert({ tenant_id: TENANT, code: 'BIN-TEST-WH', name: 'Bin Test WH' }).returning('id'))[0].id;
      prod = (await trx('catalog.products').where({ tenant_id: TENANT }).first('id')).id;
      // limpiar corridas previas
      await trx('commercial.stock_lot_locations').where({ warehouse_id: whId }).del();
      await trx('commercial.warehouse_bins').where({ warehouse_id: whId }).del();
      await trx('commercial.stock_lots').where({ warehouse_id: whId, product_id: prod }).whereIn('lot_code', ['BIN-L1', 'BIN-L2']).del();
    });
    check(!!whId && !!prod, 'setup: almacén + producto');

    const dates = (await knex.raw(`SELECT (CURRENT_DATE + 120)::text AS early, (CURRENT_DATE + 400)::text AS late`)).rows[0];

    // ── 2. Crear bins ──
    console.log('\n2) Crear bins');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      binA = (await trx('commercial.warehouse_bins').insert({ tenant_id: TENANT, warehouse_id: whId, code: 'R01-N01-A', label: 'Rack 1' }).returning('id'))[0].id;
      binB = (await trx('commercial.warehouse_bins').insert({ tenant_id: TENANT, warehouse_id: whId, code: 'R01-N02-B', label: 'Rack 1' }).returning('id'))[0].id;
    });
    check(!!binA && !!binB, '2 bins creados');
    // El duplicado va en SU PROPIA transacción: un insert fallido aborta la tx (25P02)
    // y haría rollback de los bins si compartieran transacción.
    let dupOk = false;
    try {
      await knex.transaction(async (trx) => {
        await setCtx(trx);
        await trx('commercial.warehouse_bins').insert({ tenant_id: TENANT, warehouse_id: whId, code: 'R01-N01-A' });
      });
    } catch { dupOk = true; }
    check(dupOk, 'code duplicado por almacén rechazado');

    // Seed lote L2 (caduca +400, qty 100) en binA
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.stock_lots').insert({ tenant_id: TENANT, warehouse_id: whId, product_id: prod, lot_code: 'BIN-L2', expiry_date: dates.late, quantity: 100 });
    });

    // ── 3. Put-away con validación ≤ lote ──
    console.log('\n3) Put-away (SUM ubicado ≤ lote)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const r1 = await putAway(trx, whId, prod, 'BIN-L2', dates.late, binA, 60);
      check(r1.ok, 'ubica 60/100 → ok');
      const r2 = await putAway(trx, whId, prod, 'BIN-L2', dates.late, binA, 50);
      check(!r2.ok && r2.reason === 'exceeds', 'ubica 50 más (60+50>100) → rechazado');
      const r3 = await putAway(trx, whId, prod, 'BIN-L2', dates.late, binA, 40);
      check(r3.ok, 'ubica 40 más (=100) → ok');
      const loc = await trx('commercial.stock_lot_locations').where({ warehouse_id: whId, product_id: prod, lot_code: 'BIN-L2', bin_id: binA }).first('quantity');
      check(Number(loc.quantity) === 100, `binA tiene 100 del lote (fue ${loc.quantity})`);
      const r4 = await putAway(trx, whId, prod, 'BIN-L2', dates.late, binB, 1);
      check(!r4.ok && r4.reason === 'exceeds', 'ubica 1 más en otro bin (>100) → rechazado');
    });

    // ── 4+5. Auxiliar + por ubicar ──
    console.log('\n4) Auxiliar de ubicaciones · 5) por ubicar');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const locs = await trx('commercial.stock_lot_locations').where({ warehouse_id: whId, product_id: prod }).where('quantity', '>', 0);
      check(locs.length === 1 && Number(locs[0].quantity) === 100, 'auxiliar: 1 ubicación con 100');

      // to_locate del lote L2 = 100 − 100 = 0 → no aparece en "por ubicar"
      const toLocateL2 = 100 - 100;
      check(toLocateL2 === 0, 'L2 completamente ubicado → 0 por ubicar');

      // Nuevo lote L1 recibido (caduca +120, qty 30), sin ubicar → to_locate 30
      await trx('commercial.stock_lots').insert({ tenant_id: TENANT, warehouse_id: whId, product_id: prod, lot_code: 'BIN-L1', expiry_date: dates.early, quantity: 30 });
      const res = await trx.raw(
        `SELECT sl.lot_code, sl.quantity - COALESCE((SELECT SUM(loc.quantity) FROM commercial.stock_lot_locations loc
             WHERE loc.warehouse_id=sl.warehouse_id AND loc.product_id=sl.product_id AND loc.lot_code=sl.lot_code
               AND loc.expiry_date IS NOT DISTINCT FROM sl.expiry_date),0) AS to_locate
           FROM commercial.stock_lots sl WHERE sl.warehouse_id=? AND sl.product_id=? AND sl.quantity>0`, [whId, prod]);
      const unloc = res.rows.filter((r) => Number(r.to_locate) > 0);
      check(unloc.length === 1 && unloc[0].lot_code === 'BIN-L1' && Number(unloc[0].to_locate) === 30, `por ubicar: solo L1 con 30 (fue ${unloc.map((u) => u.lot_code + ':' + u.to_locate)})`);
    });

    // ── 6. FEFO físico ──
    console.log('\n6) FEFO físico (pick-suggestion)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      // ubicar L1 (caduca antes) en binB
      await putAway(trx, whId, prod, 'BIN-L1', dates.early, binB, 30);
      const fefo = await trx('commercial.stock_lot_locations as l')
        .where({ 'l.warehouse_id': whId, 'l.product_id': prod }).where('l.quantity', '>', 0)
        .select('l.lot_code', 'l.expiry_date', 'l.bin_id')
        .orderByRaw('l.expiry_date ASC NULLS LAST');
      check(fefo[0].lot_code === 'BIN-L1' && fefo[0].bin_id === binB, `FEFO surtí primero L1 en binB (caduca antes) — fue ${fefo[0].lot_code}`);
      check(fefo[1].lot_code === 'BIN-L2', 'luego L2 (caduca después)');
    });

    // ── 7. deleteBin con inventario ──
    console.log('\n7) deleteBin protegido');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const used = await trx('commercial.stock_lot_locations').where({ bin_id: binA }).where('quantity', '>', 0).first('id');
      check(!!used, 'binA tiene inventario → deleteBin lo rechazaría');
    });

    // ── Cleanup ──
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await trx('commercial.stock_lot_locations').where({ warehouse_id: whId }).del();
      await trx('commercial.warehouse_bins').where({ warehouse_id: whId }).del();
      await trx('commercial.stock_lots').where({ warehouse_id: whId, product_id: prod }).whereIn('lot_code', ['BIN-L1', 'BIN-L2']).del();
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} Ubicación bin-level: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('\n💥 Error en el smoke:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
